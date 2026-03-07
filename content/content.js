// WebEdit Content Script - 页面编辑核心引擎
// 负责：元素高亮、选中、文本编辑、样式修改、撤销/重做

(() => {
    'use strict';

    // =====================================================
    // 状态管理
    // =====================================================
    let isEditMode = false;        // 编辑模式是否开启
    let hoveredElement = null;     // 当前鼠标悬停的元素
    let selectedElements = [];     // 当前选中的元素列表
    let selectedElement = null;    // (兼容旧代码) 当前主选中元素（最后选中的，或唯一的）
    let isTextEditing = false;     // 是否正在编辑文本
    let isPreviewingOriginal = false; // 是否处于对比原网页状态
    let previewBanner = null;      // 对比状态下的浮层提示横幅
    let currentPreviewIndex = 0;   // 当前预览的历史步骤索引

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

    // 剪贴板（存储复制的元素 HTML 快照）
    let clipboardHTML = null;

    // 撤销/重做历史栈
    const undoStack = [];
    const redoStack = [];
    const MAX_HISTORY = 50;

    /** 安全发送扩展消息，防止 Extension context invalidated */
    function safeSendMessage(message, callback) {
        try {
            if (!chrome.runtime?.id) {
                throw new Error('Extension context invalidated.');
            }
            if (callback) {
                chrome.runtime.sendMessage(message, callback);
            } else {
                chrome.runtime.sendMessage(message, () => {
                    void chrome.runtime.lastError;
                });
            }
        } catch (error) {
            if (error && error.message && error.message.includes('Extension context invalidated')) {
                // 插件被重载，清理旧的上下文 UI 和事件
                console.warn('WebEdit: Extension context invalidated. Cleaning up...');
                if (typeof disableEditMode === 'function') {
                    disableEditMode();
                }
                document.querySelectorAll('.webedit-overlay').forEach(el => el.remove());
                document.body.classList.remove('webedit-active', 'webedit-resizing');
            } else {
                console.warn('WebEdit: Failed to send message', error);
            }
        }
    }

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
                if (action.oldValue) {
                    action.element.style.setProperty(action.property, action.oldValue, action.oldPriority || '');
                } else {
                    action.element.style.removeProperty(action.property);
                }
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
                if (action.nextSibling && action.nextSibling.parentNode === action.parent) {
                    action.parent.insertBefore(action.element, action.nextSibling);
                } else {
                    action.parent.appendChild(action.element);
                }
                break;
            case 'move':
                // 撤销移动：将元素放回原位
                if (action.oldNextSibling && action.oldNextSibling.parentNode === action.oldParent) {
                    action.oldParent.insertBefore(action.element, action.oldNextSibling);
                } else {
                    action.oldParent.appendChild(action.element);
                }
                break;
            case 'add':
            case 'paste':
                // 撤销添加/粘贴：移除新插入的元素
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
            case 'wrap-move':
                // 撤销并排包裹：将元素从容器中取出放回原位，移除容器
                // 撤销并排包裹（针对单个拖拽行为的旧实现）
                action.element.style.flex = action.elementOldFlex;
                action.target.style.flex = action.targetOldFlex;
                if (action.targetOldNextSibling && action.targetOldNextSibling.parentNode === action.targetOldParent) {
                    action.targetOldParent.insertBefore(action.target, action.targetOldNextSibling);
                } else {
                    action.targetOldParent.appendChild(action.target);
                }
                if (action.elementOldNextSibling && action.elementOldNextSibling.parentNode === action.elementOldParent) {
                    action.elementOldParent.insertBefore(action.element, action.elementOldNextSibling);
                } else {
                    action.elementOldParent.appendChild(action.element);
                }
                action.wrapper.remove();
                break;
            case 'wrap-item-move':
                // 多选打包子项撤销
                action.element.style.flex = action.oldFlex;
                action.element.style.width = action.oldWidth;
                if (action.oldNextSibling && action.oldNextSibling.parentNode === action.oldParent) {
                    action.oldParent.insertBefore(action.element, action.oldNextSibling);
                } else {
                    action.oldParent.appendChild(action.element);
                }
                break;
            case 'bulk-wrap':
                // 先把子元素移回去
                for (let i = action.subActions.length - 1; i >= 0; i--) {
                    revertAction(action.subActions[i]);
                }
                // 再移除容器本身
                action.wrapper.remove();

                // 将撤销后的所有子元素恢复选中状态
                deselectElement();
                const elementsToSelect = action.subActions.map(sa => sa.element);
                elementsToSelect.forEach(el => {
                    selectedElements.push(el);
                    el.classList.add('webedit-selected');
                });
                selectedElement = selectedElements[selectedElements.length - 1];
                sendElementStyles(selectedElement);
                break;
            case 'bulk-style':
            case 'bulk-hide':
            case 'bulk-delete':
            case 'bulk-paste':
                // 反向遍历复合操作撤销
                for (let i = action.subActions.length - 1; i >= 0; i--) {
                    revertAction(action.subActions[i]);
                }
                break;
        }
        // 同步更新 Side Panel 的样式面板
        // bulk操作如果涉及选中元素，需要统一更新一次
        if (action.element === selectedElement || action.type.startsWith('bulk-')) {
            sendElementStyles(selectedElement);
        }
    }

    /** 重新应用一个操作 */
    function applyAction(action) {
        switch (action.type) {
            case 'style':
                if (action.newValue) {
                    action.element.style.setProperty(action.property, action.newValue, 'important');
                } else {
                    action.element.style.removeProperty(action.property);
                }
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
                if (action.newNextSibling && action.newNextSibling.parentNode === action.newParent) {
                    action.newParent.insertBefore(action.element, action.newNextSibling);
                } else {
                    action.newParent.appendChild(action.element);
                }
                break;
            case 'add':
            case 'paste':
                // 重做添加/粘贴：重新插入元素到原位置
                if (action.nextSibling && action.nextSibling.parentNode === action.parent) {
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
            case 'wrap-move': {
                // 重做并排包裹：重新创建容器并放入元素
                // 将容器插入到目标元素的原位之前
                const wrapperParent = action.targetOldParent;
                if (action.targetOldNextSibling && action.targetOldNextSibling.parentNode === wrapperParent) {
                    wrapperParent.insertBefore(action.wrapper, action.targetOldNextSibling);
                } else {
                    wrapperParent.appendChild(action.wrapper);
                }
                // 注意：此时 wrapper 已经在上面 insertBefore 前面了，
                // 接下来把 target 放在 wrapper 前面（它会替代 target 的位置）
                action.element.style.flex = '1';
                action.target.style.flex = '1';
                break;
            }
            case 'wrap-item-move':
                // 因为外层 bulk-wrap 重做时会把元素 append 到 wrapper 里，
                // 这里我们只需要重做样式的修改即可（width/flex）
                if (action.element.style.getPropertyValue('flex') !== action.oldFlex) {
                    // 说明是 isRow=true 操作强制写入了 flex: 1 和 width: auto
                    action.element.style.flex = '1';
                    action.element.style.width = 'auto';
                }
                break;
            case 'bulk-wrap':
                // 重做时：重新插入容器，并把子元素放进来
                if (action.wrapperNextSibling && action.wrapperNextSibling.parentNode === action.wrapperParent) {
                    action.wrapperParent.insertBefore(action.wrapper, action.wrapperNextSibling);
                } else {
                    action.wrapperParent.appendChild(action.wrapper);
                }
                action.subActions.forEach(subAction => {
                    action.wrapper.appendChild(subAction.element);
                    applyAction(subAction);
                });
                // 重做后自动选中该容器
                selectElement(action.wrapper);
                break;
            case 'bulk-style':
            case 'bulk-hide':
            case 'bulk-delete':
            case 'bulk-paste':
                action.subActions.forEach(subAction => {
                    applyAction(subAction);
                });
                break;
        }
        if (action.element === selectedElement || action.type.startsWith('bulk-')) {
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
        if (!isEditMode || isTextEditing || isDragging || isResizing || isPreviewingOriginal) return;
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
        if (!isEditMode || isTextEditing || isDragging || isResizing || isPreviewingOriginal) return;

        const target = event.target;
        // 忽略自己的 UI 元素（包括缩放手柄）
        if (target.closest('.webedit-overlay') || target.closest('.webedit-resize-handles')) return;

        event.preventDefault();
        event.stopPropagation();

        const isMulti = event.shiftKey || event.metaKey || event.ctrlKey;

        if (isMulti) {
            toggleElementSelection(target);
        } else {
            selectElement(target);
        }
    }

    /** 切换元素的选中状态（用于多选） */
    function toggleElementSelection(element) {
        const index = selectedElements.indexOf(element);

        if (index > -1) {
            // 取消选中
            selectedElements.splice(index, 1);
            element.classList.remove('webedit-selected');

            if (selectedElements.length > 0) {
                // 还有其他选中元素，更新主选中元素
                selectedElement = selectedElements[selectedElements.length - 1];
                sendElementStyles(selectedElement);
            } else {
                // 全取消了
                deselectElement();
            }
        } else {
            // 新增选中
            selectedElements.push(element);
            selectedElement = element;
            element.classList.add('webedit-selected');
            element.classList.remove('webedit-hover');

            // 多选时移除缩放手柄，避免 UI 混乱
            removeResizeHandles();

            // 发送元素样式信息到 Side Panel
            sendElementStyles(element);
        }
    }

    /** 选中一个元素（单选） */
    function selectElement(element) {
        // 清除之前的选中
        deselectElement();

        selectedElements = [element];
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
        selectedElements.forEach(el => {
            el.classList.remove('webedit-selected');
            el.contentEditable = 'inherit';
        });
        isTextEditing = false;
        selectedElements = [];
        selectedElement = null;

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
        if (!selectedElement || isPreviewingOriginal) return;

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

            // 布局（flex 容器属性）
            flexDirection: computed.flexDirection,
            gap: computed.gap,
            justifyContent: computed.justifyContent,
            alignItems: computed.alignItems,
            flexWrap: computed.flexWrap,

            // 布局（grid 容器属性）
            gridTemplateColumns: computed.gridTemplateColumns,
        };

        const payload = {
            styles,
            tagName: element.tagName.toLowerCase(),
            path: getElementPath(element),
            textContent: element.textContent?.substring(0, 100) || '',
            hasChildren: element.children.length > 0,
            isContainer: isContainerElement(element),
            isMultiSelect: selectedElements.length > 1,
            selectedCount: selectedElements.length
        };

        safeSendMessage({
            type: 'ELEMENT_SELECTED',
            payload
        });
    }

    // =====================================================
    // 双击进入文本编辑
    // =====================================================

    function handleDoubleClick(event) {
        if (!isEditMode || isPreviewingOriginal) return;
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
        if (!selectedElements || selectedElements.length === 0) return;

        const subActions = [];

        for (const [property, value] of Object.entries(styles)) {
            const kebabProp = property.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
            selectedElements.forEach(element => {
                const oldValue = element.style.getPropertyValue(kebabProp);
                const oldPriority = element.style.getPropertyPriority(kebabProp);

                if (value) {
                    element.style.setProperty(kebabProp, value, 'important');
                } else {
                    element.style.removeProperty(kebabProp);
                }

                subActions.push({
                    type: 'style',
                    element,
                    property: kebabProp,
                    oldValue: oldValue || '',
                    oldPriority: oldPriority || '',
                    newValue: value,
                });
            });
        }

        if (subActions.length > 0) {
            pushAction({
                type: 'bulk-style',
                subActions
            });
        }

        // 更新面板显示（使用主选中元素的数据）
        if (selectedElement) {
            sendElementStyles(selectedElement);
        }
    }

    // =====================================================
    // 元素操作（隐藏/删除）
    // =====================================================

    function hideElement() {
        if (!selectedElements || selectedElements.length === 0) return;

        const subActions = [];

        selectedElements.forEach(element => {
            const oldDisplay = element.style.display;
            subActions.push({
                type: 'hide',
                element,
                oldValue: oldDisplay || '',
            });
            element.style.display = 'none';
            element.classList.add('webedit-hidden-element');
        });

        pushAction({
            type: 'bulk-hide',
            subActions
        });

        deselectElement();
    }

    function deleteElement() {
        if (!selectedElements || selectedElements.length === 0) return;

        const subActions = [];
        // 为了确保撤销时能够按正确顺序恢复，我们先记录所有元素的状态
        const elementsToRemove = [...selectedElements];

        elementsToRemove.forEach(element => {
            const parent = element.parentElement;
            const nextSibling = element.nextSibling;
            subActions.push({
                type: 'delete',
                element,
                parent,
                nextSibling,
            });
        });

        pushAction({
            type: 'bulk-delete',
            subActions
        });

        deselectElement();

        elementsToRemove.forEach(element => {
            element.remove();
        });
    }

    // =====================================================
    // 复制 / 粘贴
    // =====================================================

    /** 复制选中元素的 DOM 快照到内部剪贴板 */
    function copyElement() {
        if (!selectedElements || selectedElements.length === 0) return;

        // 支持多选复制，将多个克隆元素包裹在一个 DocumentFragment 或者简单的 wrapper 中
        // 但为了简单和兼容单选，如果只有一个，就像原来一样保存
        // 如果有多个，我们保存一个包含多个元素的数组或包裹它的 HTML

        const wrap = document.createElement('div');

        selectedElements.forEach(element => {
            const clone = element.cloneNode(true);
            const editClasses = [
                'webedit-selected', 'webedit-hover', 'webedit-drag-source',
                'webedit-drop-target', 'webedit-drop-zone', 'webedit-drop-zone-active',
                'webedit-copy-flash'
            ];
            editClasses.forEach(cls => {
                clone.classList.remove(cls);
                clone.querySelectorAll(`.${cls}`).forEach(el => el.classList.remove(cls));
            });
            // 移除克隆中的 contenteditable 属性
            clone.removeAttribute('contenteditable');
            clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));

            wrap.appendChild(clone);

            // 视觉反馈：短暂绿色闪烁
            element.classList.add('webedit-copy-flash');
            setTimeout(() => {
                element?.classList.remove('webedit-copy-flash');
            }, 400);
        });

        clipboardHTML = wrap.innerHTML;
    }

    /** 将剪贴板中的元素粘贴到页面 */
    function pasteElement() {
        if (!clipboardHTML) return;

        const temp = document.createElement('div');
        temp.innerHTML = clipboardHTML;
        const newElements = Array.from(temp.children);

        if (newElements.length === 0) return;

        // 确定插入位置
        let parent;
        let nextSibling;
        if (selectedElement && selectedElement !== document.body && selectedElement !== document.documentElement) {
            if (isContainerElement(selectedElement)) {
                parent = selectedElement;
                nextSibling = null;
            } else {
                parent = selectedElement.parentElement;
                nextSibling = selectedElement.nextSibling;
            }
        } else {
            parent = document.body;
            nextSibling = null;
        }

        const subActions = [];
        newElements.forEach(newElement => {
            newElement.classList.add('webedit-added-element');

            if (nextSibling && nextSibling.parentNode === parent) {
                parent.insertBefore(newElement, nextSibling);
            } else {
                parent.appendChild(newElement);
            }

            subActions.push({
                type: 'paste',
                element: newElement,
                parent,
                nextSibling: newElement.nextSibling,
            });
        });

        pushAction({
            type: 'bulk-paste',
            subActions
        });

        // 自动选中新粘贴的元素们
        deselectElement();
        newElements.forEach(el => {
            selectedElements.push(el);
            el.classList.add('webedit-selected');
        });
        selectedElement = newElements[newElements.length - 1];
        sendElementStyles(selectedElement);

        // 滚动到最后一个新元素可见区域
        if (selectedElement) {
            selectedElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // =====================================================
    // 添加元素
    // =====================================================

    /**
     * 向页面插入新的 DOM 元素
     * @param {string} elementType - 元素类型标识
     */
    /**
     * 判断元素是否为容器类元素（新元素应插入到其内部）
     * @param {Element} element - 目标元素
     * @returns {boolean}
     */
    function isContainerElement(element) {
        const containerTags = ['DIV', 'SECTION', 'ARTICLE', 'NAV', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'UL', 'OL'];
        if (containerTags.includes(element.tagName)) return true;
        // flex / grid 布局容器也视为容器
        const display = getComputedStyle(element).display;
        if (display === 'flex' || display === 'inline-flex' || display === 'grid') return true;
        return false;
    }

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
            if (isContainerElement(selectedElement)) {
                // 容器元素：插入到内部末尾
                parent = selectedElement;
                nextSibling = null;
                parent.appendChild(newElement);
            } else {
                // 叶子元素：在其后方插入
                parent = selectedElement.parentElement;
                nextSibling = selectedElement.nextSibling;
                if (nextSibling && nextSibling.parentNode === parent) {
                    parent.insertBefore(newElement, nextSibling);
                } else {
                    parent.appendChild(newElement);
                }
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

            case 'flex-row': {
                // 横向布局容器：两个子元素并排排列
                el = document.createElement('div');
                el.classList.add('webedit-flex-container');
                el.style.cssText = 'display: flex; flex-direction: row; gap: 16px; padding: 16px; margin: 8px 0; min-height: 80px; border-radius: 8px;';
                const rowChild1 = document.createElement('div');
                rowChild1.style.cssText = 'flex: 1; min-height: 60px; padding: 16px; background: rgba(59,130,246,0.08); border: 1px dashed rgba(59,130,246,0.3); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 14px;';
                rowChild1.textContent = '左侧区域';
                rowChild1.classList.add('webedit-added-element');
                const rowChild2 = document.createElement('div');
                rowChild2.style.cssText = 'flex: 1; min-height: 60px; padding: 16px; background: rgba(16,185,129,0.08); border: 1px dashed rgba(16,185,129,0.3); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 14px;';
                rowChild2.textContent = '右侧区域';
                rowChild2.classList.add('webedit-added-element');
                el.appendChild(rowChild1);
                el.appendChild(rowChild2);
                break;
            }

            case 'flex-col': {
                // 纵向布局容器：两个子元素上下排列
                el = document.createElement('div');
                el.classList.add('webedit-flex-container');
                el.style.cssText = 'display: flex; flex-direction: column; gap: 16px; padding: 16px; margin: 8px 0; min-height: 80px; border-radius: 8px;';
                const colChild1 = document.createElement('div');
                colChild1.style.cssText = 'flex: 1; min-height: 60px; padding: 16px; background: rgba(139,92,246,0.08); border: 1px dashed rgba(139,92,246,0.3); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 14px;';
                colChild1.textContent = '上方区域';
                colChild1.classList.add('webedit-added-element');
                const colChild2 = document.createElement('div');
                colChild2.style.cssText = 'flex: 1; min-height: 60px; padding: 16px; background: rgba(245,158,11,0.08); border: 1px dashed rgba(245,158,11,0.3); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 14px;';
                colChild2.textContent = '下方区域';
                colChild2.classList.add('webedit-added-element');
                el.appendChild(colChild1);
                el.appendChild(colChild2);
                break;
            }

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

        // 高亮所有合法放置区域
        highlightDropZones();
    }

    /**
     * 判断一个元素是否为 flex 容器
     * @param {Element} el - 目标元素
     * @returns {boolean}
     */
    function isFlexContainer(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        const display = getComputedStyle(el).display;
        return display === 'flex' || display === 'inline-flex';
    }

    /**
     * 获取 flex 容器的主轴方向
     * @param {Element} el - flex 容器元素
     * @returns {'row' | 'column'}
     */
    function getFlexDirection(el) {
        const dir = getComputedStyle(el).flexDirection;
        return (dir === 'row' || dir === 'row-reverse') ? 'row' : 'column';
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

        // 确定要插入的参考元素
        let targetEl = findDropSibling(elementBelow);
        if (!targetEl || targetEl === dragElement || dragElement.contains(targetEl) || targetEl.contains(dragElement)) {
            clearDropTarget();
            return;
        }

        // 判断目标所在的父容器是否为横向 flex 容器
        const parentEl = targetEl.parentElement;
        const parentIsFlex = parentEl && isFlexContainer(parentEl);
        const flexDir = parentIsFlex ? getFlexDirection(parentEl) : null;
        const isHorizontalFlex = flexDir === 'row';

        const targetRect = targetEl.getBoundingClientRect();
        let position;

        if (isHorizontalFlex) {
            // 已经在横向 flex 容器内 → 左右排列
            const midX = targetRect.left + targetRect.width / 2;
            position = event.clientX < midX ? 'before' : 'after';
        } else {
            // 非 flex 容器（普通文档流）→ 检测是否在左/右边缘区域
            const edgeZone = Math.max(targetRect.width * 0.25, 40); // 左右各 25%，最少 40px
            const relativeX = event.clientX - targetRect.left;

            if (relativeX < edgeZone) {
                // 鼠标在目标元素的左侧区域 → 并排放置（自动创建 flex 容器）
                position = 'left';
            } else if (relativeX > targetRect.width - edgeZone) {
                // 鼠标在目标元素的右侧区域 → 并排放置
                position = 'right';
            } else {
                // 鼠标在中间区域 → 传统的上下插入
                const midY = targetRect.top + targetRect.height / 2;
                position = event.clientY < midY ? 'before' : 'after';
            }
        }

        // 如果目标和位置没变，不做多余更新
        if (dropTarget === targetEl && dropPosition === position) return;

        clearDropTarget();
        dropTarget = targetEl;
        dropPosition = position;

        // 高亮目标
        if (position === 'left' || position === 'right') {
            // 并排模式：高亮目标元素本身
            targetEl.classList.add('webedit-drop-target');
        } else if (parentEl && parentEl !== document.body) {
            parentEl.classList.add('webedit-drop-target');
        }

        // 增强当前悬停目标的高亮（区别于其他可放置区域）
        document.querySelectorAll('.webedit-drop-zone-active').forEach(el => {
            el.classList.remove('webedit-drop-zone-active');
        });
        targetEl.classList.add('webedit-drop-zone-active');

        // 定位指示线
        if (dropIndicator) {
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            const scrollLeft = window.scrollX || document.documentElement.scrollLeft;

            if (isHorizontalFlex || position === 'left' || position === 'right') {
                // 竖向指示线（横向 flex 内 或 并排模式）
                let indicatorX;
                if (position === 'left' || position === 'before') {
                    indicatorX = targetRect.left + scrollLeft - 2;
                } else {
                    indicatorX = targetRect.right + scrollLeft + 2;
                }
                dropIndicator.style.top = (targetRect.top + scrollTop) + 'px';
                dropIndicator.style.left = indicatorX + 'px';
                dropIndicator.style.width = '3px';
                dropIndicator.style.height = targetRect.height + 'px';
                dropIndicator.classList.add('webedit-drop-indicator-vertical');
            } else {
                // 横向指示线（默认，用于纵向布局）
                const indicatorY = position === 'before'
                    ? targetRect.top + scrollTop - 1
                    : targetRect.bottom + scrollTop + 1;
                dropIndicator.style.top = indicatorY + 'px';
                dropIndicator.style.left = (targetRect.left + scrollLeft) + 'px';
                dropIndicator.style.width = targetRect.width + 'px';
                dropIndicator.style.height = '3px';
                dropIndicator.classList.remove('webedit-drop-indicator-vertical');
            }
            dropIndicator.style.display = 'block';
        }
    }

    /**
     * 查找合适的放置目标元素
     * 策略：
     * 1. 优先查找 flex 容器内的子元素（支持拖入容器）
     * 2. 搜索同一父容器内的兄弟元素
     * 3. 跨容器拖放时，找鼠标下方最近的块级元素
     * 4. 过滤掉被拖拽元素的祖先（不能把自己放进自己里面）
     */
    function findDropSibling(el) {
        if (!el || el === document.body || el === document.documentElement) return null;

        const dragParent = dragElement.parentElement;

        // 第 1 步：检查鼠标下方元素的祖先链中是否有 flex 容器（优先支持拖入容器）
        let current = el;
        while (current && current !== document.body) {
            // 安全检查：不能拖入自身或包含自身的容器
            if (current === dragElement || current.contains(dragElement)) {
                current = current.parentElement;
                continue;
            }

            // 如果 current 的父元素是 flex 容器，则 current 可作为容器内的放置参照
            if (current.parentElement && isFlexContainer(current.parentElement) &&
                current.parentElement !== dragElement && !current.parentElement.contains(dragElement) &&
                current !== dragElement) {
                return current;
            }

            // 如果 current 本身是空的 flex 容器，允许拖入（作为容器的唯一/最后一个子元素）
            if (isFlexContainer(current) && current.children.length === 0 &&
                current !== dragElement && !current.contains(dragElement)) {
                // 在 updateDropTarget 中需特殊处理空容器的情况
                return current;
            }

            current = current.parentElement;
        }

        // 第 2 步：搜索同一父容器内的兄弟元素（向上遍历鼠标下方元素的祖先链）
        current = el;
        while (current && current !== document.body) {
            if (current.parentElement === dragParent && current !== dragElement) {
                return current;
            }
            current = current.parentElement;
        }

        // 第 3 步：跨容器拖放 —— 找鼠标下方最近的合适块级元素
        current = el;
        while (current && current !== document.body) {
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

        // 第 4 步：最终回退
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
        document.querySelectorAll('.webedit-drop-zone-active').forEach(el => {
            el.classList.remove('webedit-drop-zone-active');
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

        // 并排模式：自动创建 flex 容器包裹目标和拖拽元素
        if (dropPosition === 'left' || dropPosition === 'right') {
            executeWrapDrop(element, oldParent, oldNextSibling);
            return;
        }

        // 普通模式：标准 DOM 移动（before/after）
        let newParent;
        let newNextSibling;

        if (dropPosition === 'before') {
            newParent = dropTarget.parentElement;
            newNextSibling = dropTarget;
            if (dropTarget.parentNode === newParent) {
                newParent.insertBefore(element, dropTarget);
            } else {
                newParent.appendChild(element);
            }
        } else {
            newParent = dropTarget.parentElement;
            newNextSibling = dropTarget.nextSibling;
            if (newNextSibling && newNextSibling.parentNode === newParent) {
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

    /**
     * 执行并排放置：创建 flex 容器包裹目标和拖拽元素
     * 这会将 dropTarget 从原位置取出，用一个新的 flex-row 容器替代，
     * 然后将 dropTarget 和 dragElement 作为子元素放入容器中。
     */
    function executeWrapDrop(element, oldParent, oldNextSibling) {
        const target = dropTarget;
        const targetParent = target.parentElement;
        const targetNextSibling = target.nextSibling;

        // 创建 flex-row 容器
        const wrapper = document.createElement('div');
        wrapper.classList.add('webedit-flex-container', 'webedit-added-element');
        wrapper.style.cssText = 'display: flex; flex-direction: row; gap: 16px; padding: 0; margin: 0; min-height: 0; align-items: stretch;';

        // 将容器插入到目标元素原来的位置
        if (target.parentNode === targetParent) {
            targetParent.insertBefore(wrapper, target);
        } else {
            targetParent.appendChild(wrapper);
        }

        // 按照左/右顺序将元素放入容器
        if (dropPosition === 'left') {
            wrapper.appendChild(element);
            wrapper.appendChild(target);
        } else {
            wrapper.appendChild(target);
            wrapper.appendChild(element);
        }

        // 为子元素添加 flex: 1 使其等宽分布
        element.style.flex = '1';
        target.style.flex = '1';

        // 记录复合操作到历史栈（支持撤销）
        pushAction({
            type: 'wrap-move',
            element,               // 被拖拽的元素
            target,                 // 目标元素（被包裹的）
            wrapper,                // 新创建的 flex 容器
            position: dropPosition, // 'left' 或 'right'
            // 用于撤销时恢复原始位置
            elementOldParent: oldParent,
            elementOldNextSibling: oldNextSibling,
            targetOldParent: targetParent,
            targetOldNextSibling: targetNextSibling,
            // 记录添加的 flex 样式，撤销时需移除
            elementOldFlex: element.style.getPropertyValue('flex') || '',
            targetOldFlex: target.style.getPropertyValue('flex') || '',
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
        clearDropZones();

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
    // 拖拽放置区域可视化提示
    // =====================================================

    /**
     * 收集所有合法放置目标元素
     * 策略：从 document.body 出发，递归扫描所有可见的块级元素；
     * 排除被拖拽元素自身及其子孙、WebEdit UI 元素。
     * @param {Element} dragEl - 正在被拖拽的元素
     * @returns {Set<Element>} 合法放置目标集合
     */
    function collectDropZones(dragEl) {
        const zones = new Set();
        if (!dragEl) return zones;

        // 不应被高亮的标签（内联元素、脚本、样式等）
        const skipTags = new Set([
            'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'BR', 'HR',
            'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
        ]);

        /**
         * 判断元素是否在视口附近可见（含上下各一屏缓冲）
         */
        function isNearViewport(el) {
            const rect = el.getBoundingClientRect();
            const buffer = window.innerHeight;
            // 元素完全在视口上方/下方超出缓冲区则不可见
            if (rect.bottom < -buffer || rect.top > window.innerHeight + buffer) return false;
            // 元素尺寸为零则不可见
            if (rect.width === 0 && rect.height === 0) return false;
            return true;
        }

        /**
         * 判断元素是否为合法放置目标（可见的块级元素）
         */
        function isDroppable(el) {
            if (!el || el === document.body || el === document.documentElement) return false;
            if (skipTags.has(el.tagName)) return false;
            // 隐藏元素跳过
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const display = style.display;
            return display === 'block' || display === 'flex' || display === 'inline-flex' ||
                display === 'grid' || display === 'list-item' || display === 'table' ||
                display === 'inline-block' || display === 'flow-root';
        }

        /**
         * 从 body 开始递归收集
         */
        function scan(parent) {
            for (const child of parent.children) {
                // 跳过被拖拽的元素及其子元素
                if (child === dragEl || dragEl.contains(child)) continue;
                // 跳过包含被拖拽元素的祖先（但继续扫描其子级）
                if (child.contains(dragEl)) {
                    scan(child);
                    continue;
                }
                // 跳过 WebEdit 自身的 UI 元素
                if (child.classList.contains('webedit-overlay') ||
                    child.classList.contains('webedit-drag-ghost') ||
                    child.classList.contains('webedit-drop-indicator') ||
                    child.classList.contains('webedit-resize-handles')) continue;
                // 跳过不应高亮的标签
                if (skipTags.has(child.tagName)) continue;

                // 性能优化：只处理视口附近的元素
                if (!isNearViewport(child)) continue;

                if (isDroppable(child)) {
                    zones.add(child);
                }

                // 继续递归子级（捕获嵌套的块级元素）
                if (child.children.length > 0) {
                    scan(child);
                }
            }
        }

        scan(document.body);
        return zones;
    }

    /**
     * 高亮所有合法放置区域
     * 在 startDrag 中调用，为用户提供全局可放置位置的视觉提示
     */
    function highlightDropZones() {
        if (!dragElement) return;
        const zones = collectDropZones(dragElement);
        zones.forEach(el => {
            el.classList.add('webedit-drop-zone');
        });
    }

    /**
     * 清除所有放置区域的高亮
     * 在 endDrag 中调用
     */
    function clearDropZones() {
        document.querySelectorAll('.webedit-drop-zone').forEach(el => {
            el.classList.remove('webedit-drop-zone');
        });
        document.querySelectorAll('.webedit-drop-zone-active').forEach(el => {
            el.classList.remove('webedit-drop-zone-active');
        });
    }

    function handleWindowResize() {
        if (isEditMode && selectedElement) {
            // 当窗口/视口大小改变时，重新计算并定位选中元素的缩放手柄
            updateResizeHandles();
        }
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

        // 窗口尺寸变化 (响应式预览切换、缩放等情况)
        window.addEventListener('resize', handleWindowResize, true);
    }

    function disableEditMode() {
        if (isPreviewingOriginal) {
            togglePreviewOriginal(false);
        }

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
        window.removeEventListener('resize', handleWindowResize, true);
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

        // Ctrl/Cmd + C = 复制选中元素
        if ((event.ctrlKey || event.metaKey) && event.key === 'c' && selectedElement) {
            event.preventDefault();
            copyElement();
            return;
        }

        // Ctrl/Cmd + V = 粘贴元素
        if ((event.ctrlKey || event.metaKey) && event.key === 'v' && clipboardHTML) {
            event.preventDefault();
            pasteElement();
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
            'webedit-drop-indicator', 'webedit-drop-target', 'webedit-added-element',
            'webedit-flex-container', 'webedit-drop-zone', 'webedit-drop-zone-active',
            'webedit-copy-flash'
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

        // 确保所有在 undoStack 中被修改过的元素都拥有唯一导出 ID
        // 调用一次 getCssPatch 以及 getActionLog 会自动分配这些 ID
        // 为了防患未然，我们在这里显式分配一次
        undoStack.forEach(action => {
            if (action.element) getExportId(action.element);
            if (action.wrapper) getExportId(action.wrapper);
            if (action.target) getExportId(action.target);
            if (action.subActions) {
                action.subActions.forEach(sub => {
                    if (sub.element) getExportId(sub.element);
                });
            }
        });

        // 移除可能因为上面的 class 清理导致的空 class 属性
        document.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));

        const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;

        // 恢复编辑模式的 class
        elementsWithEditClasses.forEach(({ el, cls }) => {
            el.classList.add(cls);
        });

        return html;
    }

    // =====================================================
    // 特殊交互功能 - 多选布局分组
    // =====================================================

    /**
     * 将当前选中的所有分散元素打包到一个 Flex 容器中
     * @param {string} direction 'row' 或 'column'
     */
    function groupSelectedElements(direction) {
        if (!selectedElements || selectedElements.length < 2) return;

        // 根据文档流位置对选中的元素进行排序，以确保打包后的顺序与视觉/DOM 顺序一致
        const sortedElements = [...selectedElements].sort((a, b) => {
            // compareDocumentPosition: 4 (Node.DOCUMENT_POSITION_FOLLOWING), 2 (Node.DOCUMENT_POSITION_PRECEDING)
            return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
        });

        // 确定插入容器的位置 (第一个选中的元素原本所在的地方)
        const primaryElement = sortedElements[0];
        const primaryParent = primaryElement.parentElement;
        const primaryNextSibling = primaryElement.nextSibling;

        // 创建新的 Flex 容器
        const wrapper = document.createElement('div');
        wrapper.classList.add('webedit-flex-container', 'webedit-added-element');
        // 根据方向设置初始样式
        const isRow = direction === 'row';
        wrapper.style.cssText = `display: flex; flex-direction: ${isRow ? 'row' : 'column'}; gap: 16px; padding: 16px; margin: 0; align-items: stretch;`;

        // 将容器插入到文档中
        if (primaryNextSibling && primaryNextSibling.parentNode === primaryParent) {
            primaryParent.insertBefore(wrapper, primaryNextSibling);
        } else {
            primaryParent.appendChild(wrapper);
        }

        // 收集撤销所需要的旧位置状态，并把它们移动到容器里
        const subActions = [];

        sortedElements.forEach(element => {
            const oldParent = element.parentElement;
            const oldNextSibling = element.nextSibling;
            const oldFlex = element.style.getPropertyValue('flex') || '';
            const oldWidth = element.style.width;

            // 如果原本不是 flex 项目，且方向是 row，则默认使其平分宽度 (flex: 1)
            // 如果原本是绝对定位等，这里为了进入 flex 布局流可能需要清除，但最安全的做法是仅添加 flex: 1
            if (isRow) {
                element.style.flex = '1';
                element.style.width = 'auto'; // 清除可能干扰的宽度
            }

            wrapper.appendChild(element);

            subActions.push({
                type: 'wrap-item-move', // 内部专用的自定义子类型，用来记录移动和样式修改
                element,
                oldParent,
                oldNextSibling,
                oldFlex,
                oldWidth
            });
        });

        pushAction({
            type: 'bulk-wrap',
            wrapper,
            wrapperParent: primaryParent,
            wrapperNextSibling: wrapper.nextSibling, // 记录 wrapper 的位置以便重做
            subActions
        });

        // 打包后，自动选中这个新诞生的容器，方便用户接着改属性
        selectElement(wrapper);
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

            case 'GROUP_ELEMENTS':
                if (payload.direction) {
                    groupSelectedElements(payload.direction);
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

            case 'COPY_ELEMENT':
                copyElement();
                sendResponse({ success: true });
                break;

            case 'PASTE_ELEMENT':
                pasteElement();
                sendResponse({ success: true });
                break;

            case 'GET_PAGE_HTML':
                sendResponse({ html: getPageHTML() });
                break;

            case 'GET_CSS_PATCH':
                sendResponse({ css: getCssPatch() });
                break;

            case 'GET_ACTION_LOG':
                sendResponse({ json: getActionLog() });
                break;

            case 'PREVIEW_ORIGINAL':
                togglePreviewOriginal(payload.show);
                sendResponse({ success: true });
                break;

            default:
                break;
        }
    });

    // =====================================================
    // 数据导出功能 (HTML, CSS Patch, Action Log)
    // =====================================================

    /** 
     * 为导出的元素分配并获取唯一标识符 
     * 用于在 HTML 源码和 CSS Patch 间建立关联
     */
    let exportIdCounter = 0;
    function getExportId(element) {
        if (!element) return null;
        let id = element.getAttribute('data-webedit-export-id');
        if (!id) {
            exportIdCounter++;
            id = Date.now().toString(36) + '-' + exportIdCounter;
            element.setAttribute('data-webedit-export-id', id);
        }
        return id;
    }

    /**
     * 生成 CSS Patch
     * 遍历所有在历史栈中被修改过内联样式的元素，收集其 style 属性并生成 CSS 规则
     */
    function getCssPatch() {
        const styledElements = new Set();

        // 1. 从 undoStack 中找到所有被修改过样式的元素
        undoStack.forEach(action => {
            if (action.type === 'style' && action.element) {
                styledElements.add(action.element);
            } else if (action.type.startsWith('bulk-') && action.subActions) {
                action.subActions.forEach(sub => {
                    if (sub.type === 'style' && sub.element) {
                        styledElements.add(sub.element);
                    }
                });
            } else if (action.type === 'wrap-move') {
                if (action.wrapper) styledElements.add(action.wrapper);
                if (action.element) styledElements.add(action.element);
                if (action.target) styledElements.add(action.target);
            } else if (action.type === 'resize' && action.element) {
                styledElements.add(action.element);
            }
        });

        // 2. 如果没有样式修改，也至少检查当前带有 style 属性（且由插件生成的）的元素
        // 这里简化处理：我们只导出 undoStack 涉及到的元素的内联样式

        let cssLines = [];
        cssLines.push('/* WebEdit CSS Patch Generated on ' + new Date().toLocaleString() + ' */');
        cssLines.push('');

        styledElements.forEach(element => {
            if (!document.body.contains(element)) return; // 忽略已被删除的元素

            const cssText = element.style.cssText;
            if (!cssText) return;

            const exportId = getExportId(element);
            // 格式化输出
            const formattedCssText = cssText.split(';').map(s => s.trim()).filter(Boolean).join(';\n  ') + ';';

            cssLines.push(`[data-webedit-export-id="${exportId}"] {`);
            cssLines.push(`  ${formattedCssText}`);
            cssLines.push('}\n');
        });

        if (cssLines.length <= 2) return null; // No actual CSS
        return cssLines.join('\n');
    }

    /**
     * 生成操作日志 (JSON)
     * 序列化 undoStack，将 DOM 引用替换为路径或 ID
     */
    function getActionLog() {
        if (undoStack.length === 0) return null;

        // 辅助序列化函数
        const serializeAction = (act) => {
            const serialized = { type: act.type };

            // 基础属性
            if (act.property) serialized.property = act.property;
            if (act.oldValue !== undefined) serialized.oldValue = act.oldValue;
            if (act.newValue !== undefined) serialized.newValue = act.newValue;
            if (act.oldWidth) serialized.oldWidth = act.oldWidth;
            if (act.newWidth) serialized.newWidth = act.newWidth;
            if (act.oldHeight) serialized.oldHeight = act.oldHeight;
            if (act.newHeight) serialized.newHeight = act.newHeight;

            // DOM 元素引用处理
            if (act.element) {
                serialized.elementId = getExportId(act.element);
                serialized.elementPath = getElementPath(act.element);
                serialized.elementTagName = act.element.tagName.toLowerCase();
            }
            if (act.wrapper) serialized.wrapperId = getExportId(act.wrapper);
            if (act.target) serialized.targetId = getExportId(act.target);

            // 递归处理嵌套 Action
            if (act.subActions && Array.isArray(act.subActions)) {
                serialized.subActions = act.subActions.map(serializeAction);
            }

            return serialized;
        };

        const logData = {
            exportTime: new Date().toISOString(),
            totalActions: undoStack.length,
            actions: undoStack.map(serializeAction)
        };

        return JSON.stringify(logData, null, 2);
    }

    // =====================================================
    // 预览模式状态切换 & 历史滑动
    // =====================================================

    /** 切换“预览原始网页”状态 */
    function togglePreviewOriginal(show) {
        if (show === isPreviewingOriginal) return;

        isPreviewingOriginal = show;

        if (show) {
            // 取消所有高亮和选中
            deselectElement();
            if (hoveredElement) {
                hoveredElement.classList.remove('webedit-hover');
                hoveredElement = null;
            }

            // 先撤销所有操作，回到0步
            for (let i = undoStack.length - 1; i >= 0; i--) {
                revertAction(undoStack[i]);
            }
            currentPreviewIndex = 0;

            // 显示滑块横幅
            if (!previewBanner) {
                previewBanner = document.createElement('div');
                previewBanner.classList.add('webedit-overlay');
                previewBanner.style.cssText = `
                    position: fixed;
                    top: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(15, 23, 42, 0.95);
                    color: white;
                    padding: 16px 24px;
                    border-radius: 16px;
                    font-size: 14px;
                    font-weight: 500;
                    font-family: system-ui, -apple-system, sans-serif;
                    z-index: 2147483647;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255,255,255,0.1);
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    animation: webeditFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                    min-width: 320px;
                `;

                // HTML 结构：标题 + 滑块 + 当前步骤文本
                previewBanner.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; width: 100%; justify-content: center;">
                        <span style="font-size: 16px;">🕰️</span>
                        <span style="font-weight: 600; letter-spacing: 0.5px; text-shadow: 0 1px 2px rgba(0,0,0,0.5);">历史修改对比预览</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px; width: 100%;">
                        <span style="font-size: 12px; color: #94a3b8; font-variant-numeric: tabular-nums;">最初</span>
                        <input type="range" id="webedit-history-slider" min="0" max="` + undoStack.length + `" value="0" 
                            style="flex: 1; accent-color: #3b82f6; height: 4px; border-radius: 2px; cursor: pointer; background: rgba(255,255,255,0.2); appearance: none; outline: none;">
                        <span style="font-size: 12px; color: #94a3b8; font-variant-numeric: tabular-nums;">最新</span>
                    </div>
                    <div id="webedit-history-label" style="font-size: 13px; color: #cbd5e1; background: rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 20px;">
                        处于原始状态 ( 0 / ` + undoStack.length + ` )
                    </div>
                `;

                // 给 slider 的 thumb 加上样式
                const style = document.createElement('style');
                style.id = 'webedit-slider-style';
                style.textContent = `
                    #webedit-history-slider::-webkit-slider-thumb {
                        appearance: none;
                        width: 16px;
                        height: 16px;
                        border-radius: 50%;
                        background: #fff;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
                        cursor: grab;
                        transition: transform 0.1s;
                    }
                    #webedit-history-slider::-webkit-slider-thumb:hover { transform: scale(1.15); }
                    #webedit-history-slider::-webkit-slider-thumb:active { cursor: grabbing; transform: scale(0.95); }
                `;
                if (!document.getElementById('webedit-slider-style')) {
                    document.head.appendChild(style);
                }

                document.body.appendChild(previewBanner);

                // 绑定拖拽事件 (Time-travel)
                const slider = previewBanner.querySelector('#webedit-history-slider');
                const label = previewBanner.querySelector('#webedit-history-label');

                slider.addEventListener('input', (e) => {
                    const targetIndex = parseInt(e.target.value, 10);
                    const stackLen = undoStack.length;

                    // 当向右拖（重播修改）
                    while (currentPreviewIndex < targetIndex) {
                        applyAction(undoStack[currentPreviewIndex]);
                        currentPreviewIndex++;
                    }

                    // 当向左拖（撤销修改）
                    while (currentPreviewIndex > targetIndex) {
                        currentPreviewIndex--;
                        revertAction(undoStack[currentPreviewIndex]);
                    }

                    // 更新文字提示
                    if (targetIndex === 0) {
                        label.textContent = "处于原始状态 ( 0 / " + stackLen + " )";
                        label.style.color = '#cbd5e1';
                    } else if (targetIndex === stackLen) {
                        label.textContent = "处于最新状态 ( " + targetIndex + " / " + stackLen + " )";
                        label.style.color = '#3b82f6';
                    } else {
                        label.textContent = "预览第 " + targetIndex + " 步的修改 ( " + targetIndex + " / " + stackLen + " )";
                        label.style.color = '#f8fafc';
                    }
                });

                // 防止点击 banner 穿透并停止事件冒泡
                previewBanner.addEventListener('mousedown', (e) => e.stopPropagation());
                previewBanner.addEventListener('click', (e) => e.stopPropagation());
                previewBanner.addEventListener('mouseover', (e) => e.stopPropagation());

                if (!document.getElementById('webedit-anim-style')) {
                    const animStyle = document.createElement('style');
                    animStyle.id = 'webedit-anim-style';
                    animStyle.textContent = `
                        @keyframes webeditFadeIn {
                            from { opacity: 0; transform: translate(-50%, -15px) scale(0.97); }
                            to { opacity: 1; transform: translate(-50%, 0) scale(1); }
                        }
                    `;
                    document.head.appendChild(animStyle);
                }
            }
        } else {
            // 退出预览时：从当前滑块所处的步骤 currentPreviewIndex 恢复到栈顶 undoStack.length
            for (let i = currentPreviewIndex; i < undoStack.length; i++) {
                applyAction(undoStack[i]);
            }
            currentPreviewIndex = undoStack.length; // 重置为最新位置

            // 移除横幅和注入的样式
            if (previewBanner) {
                previewBanner.style.animation = 'webeditFadeIn 0.2s reverse forwards';
                setTimeout(() => {
                    if (previewBanner) {
                        previewBanner.remove();
                        previewBanner = null;
                    }
                    const sliderStyle = document.getElementById('webedit-slider-style');
                    if (sliderStyle) sliderStyle.remove();
                }, 200);
            }
        }
    }

})();
