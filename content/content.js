// WebEdit Content Script - 页面编辑核心引擎
// 负责：元素高亮、选中、文本编辑、样式修改、撤销/重做

(() => {
    'use strict';

    // =====================================================
    // 状态管理
    // =====================================================
    let isEditMode = false;        // 编辑模式是否开启
    let hoveredElement = null;     // 当前鼠标悬停的元素
    let selectedElement = null;    // 当前选中的元素
    let isTextEditing = false;     // 是否正在编辑文本

    // 拖拽状态
    let isDragging = false;        // 是否正在拖拽
    let dragStarted = false;       // 拖拽是否已启动（超过阈值）
    let dragElement = null;        // 正在拖拽的元素
    let dragGhost = null;          // 拖拽时的幽灵克隆
    let dropIndicator = null;      // 放置位置指示线
    let dragStartX = 0;            // 拖拽起始 X 坐标
    let dragStartY = 0;            // 拖拽起始 Y 坐标
    let dropTarget = null;         // 当前放置目标
    let dropPosition = null;       // 放置位置：'before' | 'after'
    const DRAG_THRESHOLD = 5;      // 拖拽触发阈值（像素）

    // 撤销/重做历史栈
    const undoStack = [];
    const redoStack = [];
    const MAX_HISTORY = 50;

    // =====================================================
    // 操作历史：撤销/重做
    // =====================================================

    /**
     * 记录一次操作到历史栈
     * @param {Object} action - 操作记录
     * @param {string} action.type - 操作类型：'style' | 'text' | 'hide' | 'delete'
     * @param {Element} action.element - 操作的目标元素
     * @param {*} action.oldValue - 旧值
     * @param {*} action.newValue - 新值
     */
    function pushAction(action) {
        if (undoStack.length >= MAX_HISTORY) {
            undoStack.shift();
        }
        undoStack.push(action);
        // 新操作后清空重做栈
        redoStack.length = 0;
    }

    function undo() {
        if (undoStack.length === 0) return;
        const action = undoStack.pop();
        redoStack.push(action);
        revertAction(action);
    }

    function redo() {
        if (redoStack.length === 0) return;
        const action = redoStack.pop();
        undoStack.push(action);
        applyAction(action);
    }

    /** 回退一个操作 */
    function revertAction(action) {
        switch (action.type) {
            case 'style':
                action.element.style[action.property] = action.oldValue;
                break;
            case 'text':
                action.element.textContent = action.oldValue;
                break;
            case 'hide':
                action.element.style.display = action.oldValue;
                action.element.classList.remove('webedit-hidden-element');
                break;
            case 'delete':
                // 恢复被删除的元素
                if (action.nextSibling) {
                    action.parent.insertBefore(action.element, action.nextSibling);
                } else {
                    action.parent.appendChild(action.element);
                }
                break;
            case 'move':
                // 撤销移动：将元素放回原位
                if (action.oldNextSibling) {
                    action.oldParent.insertBefore(action.element, action.oldNextSibling);
                } else {
                    action.oldParent.appendChild(action.element);
                }
                break;
        }
        // 同步更新 Side Panel 的样式面板
        if (action.element === selectedElement) {
            sendElementStyles(selectedElement);
        }
    }

    /** 重新应用一个操作 */
    function applyAction(action) {
        switch (action.type) {
            case 'style':
                action.element.style[action.property] = action.newValue;
                break;
            case 'text':
                action.element.textContent = action.newValue;
                break;
            case 'hide':
                action.element.style.display = 'none';
                action.element.classList.add('webedit-hidden-element');
                break;
            case 'delete':
                action.element.remove();
                if (action.element === selectedElement) {
                    deselectElement();
                }
                break;
            case 'move':
                // 重做移动：将元素放到新位置
                if (action.newNextSibling) {
                    action.newParent.insertBefore(action.element, action.newNextSibling);
                } else {
                    action.newParent.appendChild(action.element);
                }
                break;
        }
        if (action.element === selectedElement) {
            sendElementStyles(selectedElement);
        }
    }

    // =====================================================
    // 元素高亮与选中
    // =====================================================

    /** 生成元素的 CSS 路径（用于在面板中显示位置） */
    function getElementPath(element) {
        const parts = [];
        let current = element;
        while (current && current !== document.body && current !== document.documentElement) {
            let selector = current.tagName.toLowerCase();
            if (current.id) {
                selector += `#${current.id}`;
            } else if (current.className && typeof current.className === 'string') {
                const classes = current.className.trim().split(/\s+/)
                    .filter(c => !c.startsWith('webedit-'))
                    .slice(0, 2);
                if (classes.length > 0) {
                    selector += '.' + classes.join('.');
                }
            }
            parts.unshift(selector);
            current = current.parentElement;
        }
        return parts.join(' > ');
    }

    /** 鼠标移入元素时的高亮处理 */
    function handleMouseOver(event) {
        if (!isEditMode || isTextEditing || isDragging) return;
        const target = event.target;

        // 忽略自己的 UI 元素
        if (target.closest('.webedit-overlay') || target.classList.contains('webedit-selected')) return;

        if (hoveredElement && hoveredElement !== target) {
            hoveredElement.classList.remove('webedit-hover');
        }

        hoveredElement = target;
        target.classList.add('webedit-hover');
    }

    /** 鼠标移出元素时移除高亮 */
    function handleMouseOut(event) {
        if (!isEditMode) return;
        const target = event.target;
        target.classList.remove('webedit-hover');
        if (hoveredElement === target) {
            hoveredElement = null;
        }
    }

    /** 点击选中元素 */
    function handleClick(event) {
        if (!isEditMode || isTextEditing || isDragging) return;

        const target = event.target;
        // 忽略自己的 UI 元素
        if (target.closest('.webedit-overlay')) return;

        event.preventDefault();
        event.stopPropagation();

        selectElement(target);
    }

    /** 选中一个元素 */
    function selectElement(element) {
        // 清除之前的选中
        deselectElement();

        selectedElement = element;
        element.classList.add('webedit-selected');
        element.classList.remove('webedit-hover');

        // 发送元素样式信息到 Side Panel
        sendElementStyles(element);
    }

    /** 取消选中 */
    function deselectElement() {
        if (selectedElement) {
            selectedElement.classList.remove('webedit-selected');
            selectedElement.contentEditable = 'inherit';
            isTextEditing = false;
            selectedElement = null;
        }
    }

    /** 读取并发送元素的计算样式到 Side Panel */
    function sendElementStyles(element) {
        const computed = getComputedStyle(element);
        const styles = {
            // 文本属性
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            fontStyle: computed.fontStyle,
            textDecoration: computed.textDecoration,
            textAlign: computed.textAlign,
            color: computed.color,
            lineHeight: computed.lineHeight,
            letterSpacing: computed.letterSpacing,

            // 背景
            backgroundColor: computed.backgroundColor,

            // 边框
            borderWidth: computed.borderWidth,
            borderColor: computed.borderColor,
            borderStyle: computed.borderStyle,
            borderRadius: computed.borderRadius,

            // 间距
            paddingTop: computed.paddingTop,
            paddingRight: computed.paddingRight,
            paddingBottom: computed.paddingBottom,
            paddingLeft: computed.paddingLeft,
            marginTop: computed.marginTop,
            marginRight: computed.marginRight,
            marginBottom: computed.marginBottom,
            marginLeft: computed.marginLeft,

            // 尺寸
            width: computed.width,
            height: computed.height,

            // 其他
            opacity: computed.opacity,
            display: computed.display,
        };

        const payload = {
            styles,
            tagName: element.tagName.toLowerCase(),
            path: getElementPath(element),
            textContent: element.textContent?.substring(0, 100) || '',
            hasChildren: element.children.length > 0,
        };

        chrome.runtime.sendMessage({
            type: 'ELEMENT_SELECTED',
            payload
        }).catch(() => { });
    }

    // =====================================================
    // 双击进入文本编辑
    // =====================================================

    function handleDoubleClick(event) {
        if (!isEditMode) return;
        const target = event.target;
        if (target.closest('.webedit-overlay')) return;

        event.preventDefault();
        event.stopPropagation();

        // 只允许编辑叶子节点文本（没有子元素，或者只有内联子元素）
        if (target.children.length === 0 || isInlineElement(target)) {
            enterTextEdit(target);
        }
    }

    function isInlineElement(element) {
        const inlineTags = ['A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'SMALL', 'SUB', 'SUP', 'MARK', 'CODE'];
        return Array.from(element.children).every(child => inlineTags.includes(child.tagName));
    }

    function enterTextEdit(element) {
        // 先选中元素
        selectElement(element);

        const oldText = element.textContent;
        isTextEditing = true;
        element.contentEditable = 'true';
        element.focus();

        // 选中全部文本
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        // 监听编辑结束（失焦或按 Escape / Enter）
        const finishEdit = (event) => {
            if (event.type === 'keydown') {
                if (event.key === 'Escape') {
                    // 取消编辑，恢复原文
                    element.textContent = oldText;
                    cleanup();
                    return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    cleanup();
                    return;
                }
                return;
            }
            // blur 事件
            cleanup();
        };

        const cleanup = () => {
            element.contentEditable = 'inherit';
            isTextEditing = false;
            element.removeEventListener('blur', finishEdit);
            element.removeEventListener('keydown', finishEdit);

            const newText = element.textContent;
            if (newText !== oldText) {
                pushAction({
                    type: 'text',
                    element,
                    oldValue: oldText,
                    newValue: newText,
                });
            }
        };

        element.addEventListener('blur', finishEdit);
        element.addEventListener('keydown', finishEdit);
    }

    // =====================================================
    // 样式应用
    // =====================================================

    function applyStyles(styles) {
        if (!selectedElement) return;

        for (const [property, value] of Object.entries(styles)) {
            const oldValue = selectedElement.style[property];
            selectedElement.style[property] = value;
            pushAction({
                type: 'style',
                element: selectedElement,
                property,
                oldValue: oldValue || '',
                newValue: value,
            });
        }

        // 更新面板显示
        sendElementStyles(selectedElement);
    }

    // =====================================================
    // 元素操作（隐藏/删除）
    // =====================================================

    function hideElement() {
        if (!selectedElement) return;
        const oldDisplay = selectedElement.style.display;
        pushAction({
            type: 'hide',
            element: selectedElement,
            oldValue: oldDisplay || '',
        });
        selectedElement.style.display = 'none';
        selectedElement.classList.add('webedit-hidden-element');
        deselectElement();
    }

    function deleteElement() {
        if (!selectedElement) return;
        const element = selectedElement;
        const parent = element.parentElement;
        const nextSibling = element.nextSibling;

        pushAction({
            type: 'delete',
            element,
            parent,
            nextSibling,
        });

        deselectElement();
        element.remove();
    }

    // =====================================================
    // 拖拽功能
    // =====================================================

    /** 按下鼠标：准备拖拽（仅对已选中元素生效） */
    function handleDragMouseDown(event) {
        if (!isEditMode || isTextEditing) return;
        if (event.button !== 0) return; // 仅左键

        const target = event.target;
        // 忽略 WebEdit 自身 UI
        if (target.closest('.webedit-overlay') ||
            target.classList.contains('webedit-drag-ghost') ||
            target.classList.contains('webedit-drop-indicator')) return;

        // 只有当点击的是已选中的元素（或其内部子元素）时才启动拖拽
        if (!selectedElement) return;
        if (target !== selectedElement && !selectedElement.contains(target)) return;

        // 不拖拽 body/html
        if (selectedElement === document.body || selectedElement === document.documentElement) return;

        isDragging = true;
        dragStarted = false;
        dragElement = selectedElement;
        dragStartX = event.clientX;
        dragStartY = event.clientY;

        event.preventDefault();
    }

    /** 鼠标移动：创建幽灵或更新放置指示 */
    function handleDragMouseMove(event) {
        if (!isDragging || !dragElement) return;

        const dx = event.clientX - dragStartX;
        const dy = event.clientY - dragStartY;

        // 检查是否超过拖拽阈值
        if (!dragStarted) {
            if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            dragStarted = true;
            startDrag(event);
        }

        // 移动幽灵位置
        if (dragGhost) {
            dragGhost.style.left = (event.clientX + 10) + 'px';
            dragGhost.style.top = (event.clientY + 10) + 'px';
        }

        // 查找放置目标
        updateDropTarget(event);
    }

    /** 启动拖拽：创建幽灵克隆和指示线 */
    function startDrag(event) {
        document.body.classList.add('webedit-dragging');
        dragElement.classList.add('webedit-drag-source');
        dragElement.classList.remove('webedit-selected');

        // 清除 hover 状态
        if (hoveredElement) {
            hoveredElement.classList.remove('webedit-hover');
            hoveredElement = null;
        }

        // 创建幽灵克隆（跟随鼠标的缩略图）
        dragGhost = dragElement.cloneNode(true);
        dragGhost.classList.add('webedit-drag-ghost');
        dragGhost.classList.remove('webedit-drag-source', 'webedit-selected', 'webedit-hover');
        // 限制幽灵大小
        const rect = dragElement.getBoundingClientRect();
        dragGhost.style.width = Math.min(rect.width, 400) + 'px';
        dragGhost.style.left = (event.clientX + 10) + 'px';
        dragGhost.style.top = (event.clientY + 10) + 'px';
        document.body.appendChild(dragGhost);

        // 创建放置指示线
        dropIndicator = document.createElement('div');
        dropIndicator.classList.add('webedit-drop-indicator');
        dropIndicator.style.display = 'none';
        document.body.appendChild(dropIndicator);
    }

    /** 更新放置目标和指示线位置 */
    function updateDropTarget(event) {
        // 临时隐藏幽灵和指示线，以获取鼠标下方的真实元素
        if (dragGhost) dragGhost.style.display = 'none';
        if (dropIndicator) dropIndicator.style.display = 'none';
        const elementBelow = document.elementFromPoint(event.clientX, event.clientY);
        if (dragGhost) dragGhost.style.display = '';

        if (!elementBelow || elementBelow === dragElement || dragElement.contains(elementBelow)) {
            clearDropTarget();
            return;
        }

        // 忽略 WebEdit UI 元素和 body/html
        if (elementBelow.closest('.webedit-overlay') ||
            elementBelow.classList.contains('webedit-drag-ghost') ||
            elementBelow.classList.contains('webedit-drop-indicator') ||
            elementBelow === document.body ||
            elementBelow === document.documentElement) {
            clearDropTarget();
            return;
        }

        // 确定要插入的参考元素（向上找到与拖拽元素同级别的元素）
        let targetEl = findDropSibling(elementBelow);
        if (!targetEl || targetEl === dragElement || dragElement.contains(targetEl)) {
            clearDropTarget();
            return;
        }

        // 计算放在目标元素的前面还是后面
        const targetRect = targetEl.getBoundingClientRect();
        const midY = targetRect.top + targetRect.height / 2;
        const position = event.clientY < midY ? 'before' : 'after';

        // 如果目标和位置没变，不做多余更新
        if (dropTarget === targetEl && dropPosition === position) return;

        clearDropTarget();
        dropTarget = targetEl;
        dropPosition = position;

        // 高亮目标的父容器
        if (targetEl.parentElement && targetEl.parentElement !== document.body) {
            targetEl.parentElement.classList.add('webedit-drop-target');
        }

        // 定位指示线
        if (dropIndicator) {
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
            const indicatorY = position === 'before'
                ? targetRect.top + scrollTop - 1
                : targetRect.bottom + scrollTop + 1;
            dropIndicator.style.top = indicatorY + 'px';
            dropIndicator.style.left = (targetRect.left + scrollLeft) + 'px';
            dropIndicator.style.width = targetRect.width + 'px';
            dropIndicator.style.display = 'block';
        }
    }

    /**
     * 查找合适的放置兄弟元素
     * 优先寻找与被拖拽元素处于同一父容器的兄弟，
     * 如果没有，就使用鼠标下方的元素本身
     */
    function findDropSibling(el) {
        if (!el || el === document.body || el === document.documentElement) return null;

        // 如果拖拽元素有父容器，优先在同一父容器内寻找
        const dragParent = dragElement.parentElement;
        let current = el;
        while (current && current !== document.body) {
            if (current.parentElement === dragParent && current !== dragElement) {
                return current;
            }
            current = current.parentElement;
        }

        // 如果找不到同级元素，允许跨容器拖放
        // 返回鼠标下方的最近块级元素
        current = el;
        while (current && current !== document.body) {
            const display = getComputedStyle(current).display;
            if (display === 'block' || display === 'flex' || display === 'grid' ||
                display === 'list-item' || display === 'table') {
                return current;
            }
            current = current.parentElement;
        }
        return el;
    }

    /** 清除放置目标的高亮 */
    function clearDropTarget() {
        document.querySelectorAll('.webedit-drop-target').forEach(el => {
            el.classList.remove('webedit-drop-target');
        });
        if (dropIndicator) {
            dropIndicator.style.display = 'none';
        }
        dropTarget = null;
        dropPosition = null;
    }

    /** 松开鼠标：执行放置或取消拖拽 */
    function handleDragMouseUp(event) {
        if (!isDragging) return;

        if (dragStarted && dropTarget && dragElement) {
            executeDrop();
        }

        endDrag();
    }

    /** 执行 DOM 移动 */
    function executeDrop() {
        const element = dragElement;
        const oldParent = element.parentElement;
        const oldNextSibling = element.nextSibling;

        let newParent;
        let newNextSibling;

        if (dropPosition === 'before') {
            newParent = dropTarget.parentElement;
            newNextSibling = dropTarget;
            newParent.insertBefore(element, dropTarget);
        } else {
            newParent = dropTarget.parentElement;
            newNextSibling = dropTarget.nextSibling;
            if (newNextSibling) {
                newParent.insertBefore(element, newNextSibling);
            } else {
                newParent.appendChild(element);
            }
        }

        // 记录操作到历史栈（支持撤销）
        pushAction({
            type: 'move',
            element,
            oldParent,
            oldNextSibling,
            newParent,
            newNextSibling: dropPosition === 'before' ? dropTarget : newNextSibling,
        });
    }

    /** 结束拖拽，清理状态 */
    function endDrag() {
        if (dragElement) {
            dragElement.classList.remove('webedit-drag-source');
            dragElement.classList.add('webedit-selected');
        }

        if (dragGhost) {
            dragGhost.remove();
            dragGhost = null;
        }

        clearDropTarget();

        if (dropIndicator) {
            dropIndicator.remove();
            dropIndicator = null;
        }

        document.body.classList.remove('webedit-dragging');
        isDragging = false;
        dragStarted = false;
        dragElement = null;
    }

    // =====================================================
    // 编辑模式切换
    // =====================================================

    function enableEditMode() {
        isEditMode = true;
        document.body.classList.add('webedit-active');
        document.addEventListener('mouseover', handleMouseOver, true);
        document.addEventListener('mouseout', handleMouseOut, true);
        document.addEventListener('click', handleClick, true);
        document.addEventListener('dblclick', handleDoubleClick, true);

        // 拖拽事件
        document.addEventListener('mousedown', handleDragMouseDown, true);
        document.addEventListener('mousemove', handleDragMouseMove, true);
        document.addEventListener('mouseup', handleDragMouseUp, true);

        // 键盘快捷键
        document.addEventListener('keydown', handleKeyDown, true);
    }

    function disableEditMode() {
        isEditMode = false;
        deselectElement();
        endDrag(); // 清理可能还在进行的拖拽

        if (hoveredElement) {
            hoveredElement.classList.remove('webedit-hover');
            hoveredElement = null;
        }

        document.body.classList.remove('webedit-active');
        document.removeEventListener('mouseover', handleMouseOver, true);
        document.removeEventListener('mouseout', handleMouseOut, true);
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('dblclick', handleDoubleClick, true);
        document.removeEventListener('mousedown', handleDragMouseDown, true);
        document.removeEventListener('mousemove', handleDragMouseMove, true);
        document.removeEventListener('mouseup', handleDragMouseUp, true);
        document.removeEventListener('keydown', handleKeyDown, true);
    }

    function handleKeyDown(event) {
        if (!isEditMode) return;
        // 文本编辑模式下不拦截快捷键（除了 Escape 和 Enter，已在编辑回调中处理）
        if (isTextEditing) return;

        // Escape 在拖拽时取消拖拽
        if (event.key === 'Escape' && isDragging) {
            event.preventDefault();
            endDrag();
            return;
        }

        // 拖拽中不处理其他快捷键
        if (isDragging) return;

        // Ctrl/Cmd + Z = 撤销
        if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
            event.preventDefault();
            undo();
            return;
        }

        // Ctrl/Cmd + Shift + Z 或 Ctrl/Cmd + Y = 重做
        if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.key === 'z' && event.shiftKey))) {
            event.preventDefault();
            redo();
            return;
        }

        // Delete / Backspace = 删除选中元素
        if ((event.key === 'Delete' || event.key === 'Backspace') && selectedElement) {
            event.preventDefault();
            deleteElement();
            return;
        }

        // Escape = 取消选中
        if (event.key === 'Escape') {
            event.preventDefault();
            if (selectedElement) {
                deselectElement();
            }
            return;
        }
    }

    // =====================================================
    // 获取页面 HTML（用于保存功能）
    // =====================================================

    function getPageHTML() {
        // 移除编辑模式的临时 class，获取干净的 HTML
        const editClasses = [
            'webedit-active', 'webedit-hover', 'webedit-selected', 'webedit-hidden-element',
            'webedit-dragging', 'webedit-drag-source', 'webedit-drag-ghost',
            'webedit-drop-indicator', 'webedit-drop-target'
        ];
        const elementsWithEditClasses = [];

        editClasses.forEach(cls => {
            document.querySelectorAll(`.${cls}`).forEach(el => {
                elementsWithEditClasses.push({ el, cls });
                el.classList.remove(cls);
            });
        });

        // 移除拖拽产生的临时 DOM 元素
        document.querySelectorAll('.webedit-drag-ghost, .webedit-drop-indicator').forEach(el => el.remove());

        // 移除 contentEditable 属性
        document.querySelectorAll('[contenteditable="true"]').forEach(el => {
            el.removeAttribute('contenteditable');
        });

        const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;

        // 恢复编辑模式的 class
        elementsWithEditClasses.forEach(({ el, cls }) => {
            el.classList.add(cls);
        });

        return html;
    }

    // =====================================================
    // 消息监听
    // =====================================================

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const { type, payload } = message;

        switch (type) {
            case 'SET_EDIT_MODE':
                if (payload.isEditing) {
                    enableEditMode();
                } else {
                    disableEditMode();
                }
                sendResponse({ success: true });
                break;

            case 'APPLY_STYLE':
                applyStyles(payload);
                sendResponse({ success: true });
                break;

            case 'ELEMENT_ACTION':
                if (payload.action === 'hide') {
                    hideElement();
                } else if (payload.action === 'delete') {
                    deleteElement();
                }
                sendResponse({ success: true });
                break;

            case 'UNDO':
                undo();
                sendResponse({ success: true });
                break;

            case 'REDO':
                redo();
                sendResponse({ success: true });
                break;

            case 'GET_PAGE_HTML':
                sendResponse({ html: getPageHTML() });
                break;

            default:
                break;
        }
    });

})();
