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

    // 缩放状态
    let isResizing = false;        // 是否正在缩放
    let resizeHandle = null;       // 当前拖拽的缩放手柄
    let resizeStartX = 0;          // 缩放起始鼠标 X
    let resizeStartY = 0;          // 缩放起始鼠标 Y
    let resizeStartWidth = 0;      // 缩放起始宽度
    let resizeStartHeight = 0;     // 缩放起始高度
    let resizeHandlesContainer = null; // 手柄容器 DOM

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
            case 'add':
                // 撤销添加：移除新插入的元素
                if (action.element === selectedElement) {
                    deselectElement();
                }
                action.element.remove();
                break;
            case 'resize':
                // 撤销缩放：恢复原始尺寸
                action.element.style.width = action.oldWidth;
                action.element.style.height = action.oldHeight;
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
            case 'add':
                // 重做添加：重新插入元素到原位置
                if (action.nextSibling && action.parent.contains(action.nextSibling)) {
                    action.parent.insertBefore(action.element, action.nextSibling);
                } else {
                    action.parent.appendChild(action.element);
                }
                selectElement(action.element);
                break;
            case 'resize':
                // 重做缩放：应用新尺寸
                action.element.style.width = action.newWidth;
                action.element.style.height = action.newHeight;
                if (action.element === selectedElement) {
                    updateResizeHandles();
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
        if (!isEditMode || isTextEditing || isDragging || isResizing) return;
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
        if (!isEditMode || isTextEditing || isDragging || isResizing) return;

        const target = event.target;
        // 忽略自己的 UI 元素（包括缩放手柄）
        if (target.closest('.webedit-overlay') || target.closest('.webedit-resize-handles')) return;

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

        // 创建缩放手柄
        createResizeHandles(element);

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
        // 销毁缩放手柄
        removeResizeHandles();
    }

    // =====================================================
    // 缩放手柄
    // =====================================================

    /** 8个手柄方向及对应的光标样式 */
    const RESIZE_DIRECTIONS = [
        { name: 'nw', cursor: 'nwse-resize' },
        { name: 'n', cursor: 'ns-resize' },
        { name: 'ne', cursor: 'nesw-resize' },
        { name: 'w', cursor: 'ew-resize' },
        { name: 'e', cursor: 'ew-resize' },
        { name: 'sw', cursor: 'nesw-resize' },
        { name: 's', cursor: 'ns-resize' },
        { name: 'se', cursor: 'nwse-resize' },
    ];

    /** 创建8个缩放手柄并附加到页面 */
    function createResizeHandles(element) {
        removeResizeHandles();

        resizeHandlesContainer = document.createElement('div');
        resizeHandlesContainer.classList.add('webedit-resize-handles', 'webedit-overlay');

        RESIZE_DIRECTIONS.forEach(dir => {
            const handle = document.createElement('div');
            handle.classList.add('webedit-resize-handle', `webedit-resize-${dir.name}`);
            handle.style.cursor = dir.cursor;
            handle.dataset.direction = dir.name;
            resizeHandlesContainer.appendChild(handle);
        });

        document.body.appendChild(resizeHandlesContainer);
        updateResizeHandles();

        // 监听缩放手柄的鼠标按下
        resizeHandlesContainer.addEventListener('mousedown', handleResizeMouseDown);
    }

    /** 移除缩放手柄 */
    function removeResizeHandles() {
        if (resizeHandlesContainer) {
            resizeHandlesContainer.removeEventListener('mousedown', handleResizeMouseDown);
            resizeHandlesContainer.remove();
            resizeHandlesContainer = null;
        }
    }

    /** 根据选中元素的位置更新手柄定位 */
    function updateResizeHandles() {
        if (!resizeHandlesContainer || !selectedElement) return;

        const rect = selectedElement.getBoundingClientRect();
        const scrollX = window.scrollX || document.documentElement.scrollLeft;
        const scrollY = window.scrollY || document.documentElement.scrollTop;

        // 容器覆盖在选中元素上方（绝对定位）
        const top = rect.top + scrollY;
        const left = rect.left + scrollX;
        const width = rect.width;
        const height = rect.height;

        resizeHandlesContainer.style.cssText = `
            position: absolute;
            top: ${top}px;
            left: ${left}px;
            width: ${width}px;
            height: ${height}px;
            pointer-events: none;
            z-index: 2147483645;
        `;

        // 每个手柄启用 pointer-events
        resizeHandlesContainer.querySelectorAll('.webedit-resize-handle').forEach(h => {
            h.style.pointerEvents = 'auto';
        });
    }

    /** 手柄按下：开始缩放 */
    function handleResizeMouseDown(event) {
        const handle = event.target;
        if (!handle.classList.contains('webedit-resize-handle')) return;
        if (!selectedElement) return;

        event.preventDefault();
        event.stopPropagation();

        isResizing = true;
        resizeHandle = handle.dataset.direction;
        resizeStartX = event.clientX;
        resizeStartY = event.clientY;

        const computed = getComputedStyle(selectedElement);
        resizeStartWidth = parseFloat(computed.width);
        resizeStartHeight = parseFloat(computed.height);

        // 记录旧值用于撤销
        handle._oldWidth = selectedElement.style.width || '';
        handle._oldHeight = selectedElement.style.height || '';

        document.addEventListener('mousemove', handleResizeMouseMove, true);
        document.addEventListener('mouseup', handleResizeMouseUp, true);
        document.body.classList.add('webedit-resizing');
    }

    /** 鼠标移动：实时缩放 */
    function handleResizeMouseMove(event) {
        if (!isResizing || !selectedElement) return;

        const dx = event.clientX - resizeStartX;
        const dy = event.clientY - resizeStartY;
        const dir = resizeHandle;

        let newWidth = resizeStartWidth;
        let newHeight = resizeStartHeight;

        // 根据方向计算新尺寸
        if (dir.includes('e')) newWidth = Math.max(20, resizeStartWidth + dx);
        if (dir.includes('w')) newWidth = Math.max(20, resizeStartWidth - dx);
        if (dir.includes('s')) newHeight = Math.max(20, resizeStartHeight + dy);
        if (dir.includes('n')) newHeight = Math.max(20, resizeStartHeight - dy);

        // 应用新尺寸
        if (dir.includes('e') || dir.includes('w')) {
            selectedElement.style.width = newWidth + 'px';
        }
        if (dir.includes('s') || dir.includes('n')) {
            selectedElement.style.height = newHeight + 'px';
        }

        // 更新手柄位置
        updateResizeHandles();
    }

    /** 鼠标松开：结束缩放，记录撤销 */
    function handleResizeMouseUp(event) {
        if (!isResizing) return;

        document.removeEventListener('mousemove', handleResizeMouseMove, true);
        document.removeEventListener('mouseup', handleResizeMouseUp, true);
        document.body.classList.remove('webedit-resizing');

        // 记录操作到历史栈
        if (selectedElement) {
            const handle = resizeHandlesContainer?.querySelector(`[data-direction="${resizeHandle}"]`);
            const oldWidth = handle?._oldWidth || '';
            const oldHeight = handle?._oldHeight || '';

            // 只有尺寸确实变了才记录
            if (selectedElement.style.width !== oldWidth || selectedElement.style.height !== oldHeight) {
                pushAction({
                    type: 'resize',
                    element: selectedElement,
                    oldWidth,
                    oldHeight,
                    newWidth: selectedElement.style.width,
                    newHeight: selectedElement.style.height,
                });
            }

            // 同步面板
            sendElementStyles(selectedElement);
            updateResizeHandles();
        }

        isResizing = false;
        resizeHandle = null;
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
    // 添加元素
    // =====================================================

    /**
     * 向页面插入新的 DOM 元素
     * @param {string} elementType - 元素类型标识
     */
    function addElement(elementType) {
        if (!isEditMode) return;

        const newElement = createElement(elementType);
        if (!newElement) return;

        // 标记为 WebEdit 添加的元素
        newElement.classList.add('webedit-added-element');

        // 确定插入位置
        let parent;
        let nextSibling;
        if (selectedElement && selectedElement !== document.body && selectedElement !== document.documentElement) {
            // 有选中元素：在其后方插入
            parent = selectedElement.parentElement;
            nextSibling = selectedElement.nextSibling;
            if (nextSibling) {
                parent.insertBefore(newElement, nextSibling);
            } else {
                parent.appendChild(newElement);
            }
        } else {
            // 无选中元素：插入到 body 末尾
            parent = document.body;
            nextSibling = null;
            parent.appendChild(newElement);
        }

        // 记录到历史栈（支持撤销）
        pushAction({
            type: 'add',
            element: newElement,
            parent,
            nextSibling: newElement.nextSibling, // 记录插入后的下一个兄弟
        });

        // 自动选中新元素
        selectElement(newElement);

        // 滚动到新元素可见区域
        newElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * 根据类型创建具体的 DOM 元素
     * @param {string} type - 元素类型
     * @returns {HTMLElement|null}
     */
    function createElement(type) {
        let el;

        switch (type) {
            case 'text':
                el = document.createElement('p');
                el.textContent = '这是一段新的文本内容，双击可以编辑。';
                el.style.cssText = 'padding: 8px 0; margin: 8px 0; font-size: 16px; line-height: 1.6; color: inherit;';
                break;

            case 'heading':
                el = document.createElement('h2');
                el.textContent = '新标题';
                el.style.cssText = 'padding: 4px 0; margin: 16px 0 8px; font-size: 24px; font-weight: 700; color: inherit;';
                break;

            case 'button':
                el = document.createElement('button');
                el.textContent = '按钮';
                el.type = 'button';
                el.style.cssText = 'display: inline-block; padding: 10px 24px; margin: 8px 0; font-size: 14px; font-weight: 500; color: #ffffff; background: #3b82f6; border: none; border-radius: 6px; cursor: pointer;';
                break;

            case 'divider':
                el = document.createElement('hr');
                el.style.cssText = 'border: none; border-top: 1px solid #d1d5db; margin: 16px 0;';
                break;

            case 'box':
                el = document.createElement('div');
                el.style.cssText = 'width: 100%; height: 120px; margin: 8px 0; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border-radius: 8px;';
                break;

            case 'image':
                el = document.createElement('div');
                el.style.cssText = 'width: 100%; height: 200px; margin: 8px 0; background: #f3f4f6; border: 2px dashed #d1d5db; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 14px;';
                el.textContent = '🖼️ 图片占位区域';
                break;

            case 'circle':
                el = document.createElement('div');
                el.style.cssText = 'width: 120px; height: 120px; margin: 8px auto; background: linear-gradient(135deg, #06b6d4, #3b82f6); border-radius: 50%;';
                break;

            case 'square':
                el = document.createElement('div');
                el.style.cssText = 'width: 120px; height: 120px; margin: 8px auto; background: linear-gradient(135deg, #f59e0b, #ef4444); border-radius: 0;';
                break;

            case 'link':
                el = document.createElement('a');
                el.textContent = '链接文本';
                el.href = '#';
                el.style.cssText = 'display: inline-block; padding: 4px 0; margin: 8px 0; font-size: 16px; color: #3b82f6; text-decoration: underline; cursor: pointer;';
                break;

            case 'list':
                el = document.createElement('ul');
                el.style.cssText = 'padding: 8px 0 8px 24px; margin: 8px 0; font-size: 16px; line-height: 1.8; color: inherit;';
                ['列表项 1', '列表项 2', '列表项 3'].forEach(text => {
                    const li = document.createElement('li');
                    li.textContent = text;
                    el.appendChild(li);
                });
                break;

            default:
                return null;
        }

        return el;
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
        if (!targetEl || targetEl === dragElement || dragElement.contains(targetEl) || targetEl.contains(dragElement)) {
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
     * 查找合适的放置目标元素
     * 策略：
     * 1. 优先找与被拖拽元素同一父容器下的兄弟
     * 2. 跨容器拖放时，找鼠标下方最近的块级元素
     * 3. 过滤掉被拖拽元素的祖先（不能把自己放进自己里面）
     */
    function findDropSibling(el) {
        if (!el || el === document.body || el === document.documentElement) return null;

        // 第 1 步：搜索同一父容器内的兄弟元素（向上遍历鼠标下方元素的祖先链）
        const dragParent = dragElement.parentElement;
        let current = el;
        while (current && current !== document.body) {
            if (current.parentElement === dragParent && current !== dragElement) {
                return current;
            }
            current = current.parentElement;
        }

        // 第 2 步：跨容器拖放 —— 找鼠标下方最近的合适元素
        // 从鼠标下方的元素开始，向上查找第一个块级元素
        current = el;
        while (current && current !== document.body) {
            // 关键检查：跳过 dragElement 的祖先链（不能把元素放进自己的父/祖容器里）
            if (current === dragElement || current.contains(dragElement)) {
                current = current.parentElement;
                continue;
            }

            const display = getComputedStyle(current).display;
            if (display === 'block' || display === 'flex' || display === 'grid' ||
                display === 'list-item' || display === 'table' ||
                display === 'inline-block' || display === 'flow-root') {
                return current;
            }
            current = current.parentElement;
        }

        // 第 3 步：最终回退，如果鼠标下方元素本身不是 dragElement 也不包含它
        if (el !== dragElement && !el.contains(dragElement)) {
            return el;
        }

        return null;
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
            'webedit-drop-indicator', 'webedit-drop-target', 'webedit-added-element'
        ];
        const elementsWithEditClasses = [];

        editClasses.forEach(cls => {
            document.querySelectorAll(`.${cls}`).forEach(el => {
                elementsWithEditClasses.push({ el, cls });
                el.classList.remove(cls);
            });
        });

        // 移除拖拽和缩放产生的临时 DOM 元素
        document.querySelectorAll('.webedit-drag-ghost, .webedit-drop-indicator, .webedit-resize-handles').forEach(el => el.remove());

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

            case 'ADD_ELEMENT':
                addElement(payload.elementType);
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
