// PageForge Side Panel 交互逻辑
// 负责：控件事件绑定、样式同步、与 Content Script 的消息通信

(() => {
    'use strict';

    // =====================================================
    // 状态
    // =====================================================
    let isEditing = false;
    let currentTabId = null;
    let currentElementStyles = null;
    let currentTheme = 'theme-dark'; // 默认主题

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
            console.warn('PageForge: Failed to send message', error);
        }
    }

    // =====================================================
    // DOM 引用
    // =====================================================
    const elements = {
        // 编辑模式
        toggleBtn: document.getElementById('btn-toggle-edit'),
        toggleText: document.querySelector('.toggle-text'),

        // 撤销/重做/对比
        undoBtn: document.getElementById('btn-undo'),
        redoBtn: document.getElementById('btn-redo'),
        previewBtn: document.getElementById('btn-preview'),

        // 主题选择
        themeSelector: document.getElementById('theme-selector'),

        // 面板显示切换
        noSelection: document.getElementById('no-selection'),
        editPanels: document.getElementById('edit-panels'),

        // 元素信息
        elementTag: document.getElementById('element-tag'),
        elementPath: document.getElementById('element-path'),

        // 文本控件
        fontFamily: document.getElementById('font-family'),
        fontSize: document.getElementById('font-size'),
        textColor: document.getElementById('text-color'),
        textColorHex: document.getElementById('text-color-hex'),
        btnBold: document.getElementById('btn-bold'),
        btnItalic: document.getElementById('btn-italic'),
        btnUnderline: document.getElementById('btn-underline'),
        btnAlignLeft: document.getElementById('btn-align-left'),
        btnAlignCenter: document.getElementById('btn-align-center'),
        btnAlignRight: document.getElementById('btn-align-right'),

        // 外观控件
        bgColor: document.getElementById('bg-color'),
        bgColorHex: document.getElementById('bg-color-hex'),
        opacity: document.getElementById('opacity'),
        opacityValue: document.getElementById('opacity-value'),
        borderRadius: document.getElementById('border-radius'),
        borderWidth: document.getElementById('border-width'),
        borderStyle: document.getElementById('border-style'),
        borderColor: document.getElementById('border-color'),

        // 间距控件
        paddingTop: document.getElementById('padding-top'),
        paddingRight: document.getElementById('padding-right'),
        paddingBottom: document.getElementById('padding-bottom'),
        paddingLeft: document.getElementById('padding-left'),
        marginTop: document.getElementById('margin-top'),
        marginRight: document.getElementById('margin-right'),
        marginBottom: document.getElementById('margin-bottom'),
        marginLeft: document.getElementById('margin-left'),

        // 元素操作
        btnHide: document.getElementById('btn-hide'),
        btnDelete: document.getElementById('btn-delete'),

        // 保存
        saveSection: document.getElementById('save-section'),
        btnSaveHtml: document.getElementById('btn-save-html'),
        btnSaveCss: document.getElementById('btn-save-css'),
        btnSaveJson: document.getElementById('btn-save-json'),

        // Tab 栏
        tabBar: document.getElementById('tab-bar'),
        tabEdit: document.getElementById('tab-edit'),
        tabInsert: document.getElementById('tab-insert'),

        // 布局属性
        layoutSection: document.getElementById('layout-section'),
        // Display 模式切换
        btnDisplayBlock: document.getElementById('btn-display-block'),
        btnDisplayFlex: document.getElementById('btn-display-flex'),
        btnDisplayGrid: document.getElementById('btn-display-grid'),
        // Flex 选项容器
        flexOptions: document.getElementById('flex-options'),
        btnFlexRow: document.getElementById('btn-flex-row'),
        btnFlexCol: document.getElementById('btn-flex-col'),
        flexGap: document.getElementById('flex-gap'),
        justifyContent: document.getElementById('justify-content'),
        alignItems: document.getElementById('align-items'),
        flexWrap: document.getElementById('flex-wrap'),
        // Grid 选项容器和控件
        gridOptions: document.getElementById('grid-options'),
        gridGap: document.getElementById('grid-gap'),
        gridAlignItems: document.getElementById('grid-align-items'),

        // 多选相关
        elementInfoSingle: document.getElementById('element-info-single'),
        elementInfoMulti: document.getElementById('element-info-multi'),
        multiSelectNumber: document.getElementById('multi-select-number'),
        multiSelectGroupOptions: document.getElementById('multi-select-group-options'),
        btnGroupRow: document.getElementById('btn-group-row'),
        btnGroupCol: document.getElementById('btn-group-col'),
    };

    async function init() {
        // 加载并应用主题
        await loadTheme();

        // 获取当前标签页
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            currentTabId = tab.id;

            // 导出与保存区域（现在对所有页面可见）
            elements.saveSection.style.display = 'block';

            // 初始化时同步编辑状态
            syncEditMode(currentTabId);
        }

        // 绑定事件
        bindEvents();
    }

    // =====================================================
    // 主题管理
    // =====================================================

    async function loadTheme() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['pageforge_theme'], (result) => {
                if (result.pageforge_theme) {
                    currentTheme = result.pageforge_theme;
                }
                applyTheme(currentTheme);
                if (elements.themeSelector) {
                    elements.themeSelector.value = currentTheme;
                }
                resolve();
            });
        });
    }

    function applyTheme(themeName) {
        document.body.className = document.body.className.replace(/\btheme-[a-z]+\b/g, '').trim();
        if (themeName) document.body.classList.add(themeName);
    }

    function saveTheme(themeName) {
        currentTheme = themeName;
        applyTheme(themeName);
        chrome.storage.local.set({ pageforge_theme: themeName });
    }

    // =====================================================
    // 事件绑定
    // =====================================================

    function bindEvents() {
        // 主题切换
        if (elements.themeSelector) {
            elements.themeSelector.addEventListener('change', (e) => {
                saveTheme(e.target.value);
            });
        }

        // 视口切换
        const viewportBtns = [
            document.getElementById('btn-vp-desktop'),
            document.getElementById('btn-vp-tablet'),
            document.getElementById('btn-vp-mobile')
        ];
        viewportBtns.forEach(btn => {
            if (!btn) return;
            btn.addEventListener('click', () => {
                viewportBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const width = btn.dataset.width === 'default' ? 'default' : parseInt(btn.dataset.width);
                if (currentTabId) {
                    safeSendMessage({
                        type: 'SET_VIEWPORT',
                        payload: { tabId: currentTabId, width }
                    });
                }
            });
        });

        // 编辑模式切换
        elements.toggleBtn.addEventListener('click', toggleEditMode);

        // 撤销/重做/对比
        elements.undoBtn.addEventListener('click', () => sendAction('UNDO'));
        elements.redoBtn.addEventListener('click', () => sendAction('REDO'));
        elements.previewBtn.addEventListener('click', togglePreviewOriginal);

        // Tab 切换
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.dataset.tab;
                switchTab(tabName);
            });
        });

        // 文本样式
        elements.fontFamily.addEventListener('change', () => applyStyle({ fontFamily: elements.fontFamily.value }));
        elements.fontSize.addEventListener('change', () => applyStyle({ fontSize: elements.fontSize.value + 'px' }));
        elements.fontSize.addEventListener('input', () => applyStyle({ fontSize: elements.fontSize.value + 'px' }));

        // 文字颜色
        elements.textColor.addEventListener('input', (e) => {
            elements.textColorHex.value = e.target.value;
            applyStyle({ color: e.target.value });
        });
        elements.textColorHex.addEventListener('change', (e) => {
            const color = normalizeColor(e.target.value);
            if (color) {
                elements.textColor.value = color;
                applyStyle({ color });
            }
        });

        // 文字样式按钮
        elements.btnBold.addEventListener('click', () => {
            const isBold = elements.btnBold.classList.toggle('active');
            applyStyle({ fontWeight: isBold ? 'bold' : 'normal' });
        });
        elements.btnItalic.addEventListener('click', () => {
            const isItalic = elements.btnItalic.classList.toggle('active');
            applyStyle({ fontStyle: isItalic ? 'italic' : 'normal' });
        });
        elements.btnUnderline.addEventListener('click', () => {
            const isUnderline = elements.btnUnderline.classList.toggle('active');
            applyStyle({ textDecoration: isUnderline ? 'underline' : 'none' });
        });

        // 文本对齐
        const alignBtns = [elements.btnAlignLeft, elements.btnAlignCenter, elements.btnAlignRight];
        alignBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                alignBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyStyle({ textAlign: btn.dataset.align });
            });
        });

        // 背景颜色
        elements.bgColor.addEventListener('input', (e) => {
            elements.bgColorHex.value = e.target.value;
            applyStyle({ backgroundColor: e.target.value });
        });
        elements.bgColorHex.addEventListener('change', (e) => {
            const color = normalizeColor(e.target.value);
            if (color) {
                elements.bgColor.value = color;
                applyStyle({ backgroundColor: color });
            }
        });

        // 透明度
        elements.opacity.addEventListener('input', (e) => {
            elements.opacityValue.textContent = e.target.value;
            applyStyle({ opacity: e.target.value });
        });

        // 圆角
        elements.borderRadius.addEventListener('change', () => applyStyle({ borderRadius: elements.borderRadius.value + 'px' }));
        elements.borderRadius.addEventListener('input', () => applyStyle({ borderRadius: elements.borderRadius.value + 'px' }));

        // 边框
        elements.borderWidth.addEventListener('change', updateBorder);
        elements.borderStyle.addEventListener('change', updateBorder);
        elements.borderColor.addEventListener('input', updateBorder);

        // 间距
        const spacingInputs = [
            { id: 'paddingTop', prop: 'paddingTop' },
            { id: 'paddingRight', prop: 'paddingRight' },
            { id: 'paddingBottom', prop: 'paddingBottom' },
            { id: 'paddingLeft', prop: 'paddingLeft' },
            { id: 'marginTop', prop: 'marginTop' },
            { id: 'marginRight', prop: 'marginRight' },
            { id: 'marginBottom', prop: 'marginBottom' },
            { id: 'marginLeft', prop: 'marginLeft' },
        ];

        spacingInputs.forEach(({ id, prop }) => {
            const input = elements[id];
            const handler = () => applyStyle({ [prop]: input.value + 'px' });
            input.addEventListener('change', handler);
            input.addEventListener('input', handler);
        });

        // 元素操作
        elements.btnHide.addEventListener('click', () => sendElementAction('hide'));
        elements.btnDelete.addEventListener('click', () => sendElementAction('delete'));

        // 添加元素按钮
        document.querySelectorAll('.add-element-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const elementType = btn.dataset.elementType;
                if (elementType && currentTabId) {
                    safeSendMessage({
                        type: 'ADD_ELEMENT',
                        payload: { tabId: currentTabId, elementType }
                    });
                }
            });
        });

        // ===== Display 模式切换 =====
        const displayModeBtns = [elements.btnDisplayBlock, elements.btnDisplayFlex, elements.btnDisplayGrid];
        displayModeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.display;
                displayModeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // 切换 Flex / Grid 子选项面板的显示
                elements.flexOptions.style.display = mode === 'flex' ? 'block' : 'none';
                elements.gridOptions.style.display = mode === 'grid' ? 'block' : 'none';

                if (mode === 'flex') {
                    applyStyle({ display: 'flex', gridTemplateColumns: '' });
                } else if (mode === 'grid') {
                    applyStyle({ display: 'grid', flexDirection: '', flexWrap: '', gridTemplateColumns: 'repeat(2, 1fr)' });
                } else {
                    // block 模式：清除 flex/grid 相关属性
                    applyStyle({ display: 'block', flexDirection: '', flexWrap: '', gridTemplateColumns: '' });
                }
            });
        });

        // ===== Flex 布局属性控件 =====
        const flexDirBtns = [elements.btnFlexRow, elements.btnFlexCol];
        flexDirBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                flexDirBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyStyle({ flexDirection: btn.dataset.direction });
            });
        });

        elements.flexGap.addEventListener('change', () => applyStyle({ gap: elements.flexGap.value + 'px' }));
        elements.flexGap.addEventListener('input', () => applyStyle({ gap: elements.flexGap.value + 'px' }));

        elements.justifyContent.addEventListener('change', () => applyStyle({ justifyContent: elements.justifyContent.value }));
        elements.alignItems.addEventListener('change', () => applyStyle({ alignItems: elements.alignItems.value }));
        elements.flexWrap.addEventListener('change', () => applyStyle({ flexWrap: elements.flexWrap.value }));

        // ===== Grid 布局属性控件 =====
        document.querySelectorAll('.grid-col-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.grid-col-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const cols = btn.dataset.cols;
                applyStyle({ gridTemplateColumns: `repeat(${cols}, 1fr)` });
            });
        });

        elements.gridGap.addEventListener('change', () => applyStyle({ gap: elements.gridGap.value + 'px' }));
        elements.gridGap.addEventListener('input', () => applyStyle({ gap: elements.gridGap.value + 'px' }));
        elements.gridAlignItems.addEventListener('change', () => applyStyle({ alignItems: elements.gridAlignItems.value }));

        // ===== 多选编组 =====
        elements.btnGroupRow.addEventListener('click', () => {
            if (!currentTabId) return;
            safeSendMessage({ type: 'GROUP_ELEMENTS', payload: { tabId: currentTabId, direction: 'row' } });
        });
        elements.btnGroupCol.addEventListener('click', () => {
            if (!currentTabId) return;
            safeSendMessage({ type: 'GROUP_ELEMENTS', payload: { tabId: currentTabId, direction: 'column' } });
        });

        // 保存/导出
        elements.btnSaveHtml.addEventListener('click', saveHtmlPage);
        elements.btnSaveCss.addEventListener('click', exportCssPatch);
        elements.btnSaveJson.addEventListener('click', exportActionLog);

        // 监听来自 Content Script 的消息
        chrome.runtime.onMessage.addListener(handleMessage);

        // 监听标签页切换
        chrome.tabs.onActivated.addListener(async (activeInfo) => {
            currentTabId = activeInfo.tabId;
            const tab = await chrome.tabs.get(currentTabId);
            // 导出与保存区域（现在对所有页面可见）
            elements.saveSection.style.display = 'block';
            // 重置面板
            showNoSelection();

            // 切换 Tab 时同步编辑状态
            syncEditMode(currentTabId);
        });

        // 监听标签页刷新或更新
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (tabId === currentTabId && changeInfo.status === 'complete') {
                // 页面刷新后，编辑状态重置或由 Background 提供
                syncEditMode(currentTabId);
            }
        });
    }

    // =====================================================
    // 编辑模式
    // =====================================================

    function toggleEditMode() {
        isEditing = !isEditing;

        elements.toggleBtn.classList.toggle('active', isEditing);
        elements.toggleText.textContent = isEditing ? '关闭编辑模式' : '开启编辑模式';
        elements.undoBtn.disabled = !isEditing;
        elements.redoBtn.disabled = !isEditing;
        elements.previewBtn.disabled = !isEditing;

        // 显示/隐藏 Tab 栏
        elements.tabBar.style.display = isEditing ? 'flex' : 'none';

        if (!isEditing) {
            showNoSelection();
            // 关闭编辑模式时重置到编辑 Tab
            switchTab('edit');
        }

        safeSendMessage({
            type: 'TOGGLE_EDIT_MODE',
            payload: { tabId: currentTabId, isEditing }
        });
    }

    /** 从 Background 同步当前 Tab 的编辑模式状态 */
    function syncEditMode(tabId) {
        if (!tabId) return;
        safeSendMessage({
            type: 'GET_EDIT_MODE_STATE',
            payload: { tabId }
        }, (response) => {
            if (response && typeof response.isEditing === 'boolean') {
                isEditing = response.isEditing;

                elements.toggleBtn.classList.toggle('active', isEditing);
                elements.toggleText.textContent = isEditing ? '关闭编辑模式' : '开启编辑模式';
                elements.undoBtn.disabled = !isEditing;
                elements.redoBtn.disabled = !isEditing;
                elements.previewBtn.disabled = !isEditing;

                // 显示/隐藏 Tab 栏
                elements.tabBar.style.display = isEditing ? 'flex' : 'none';

                if (!isEditing) {
                    showNoSelection();
                    switchTab('edit');
                }
            }
        });
    }

    /** 切换 Tab 页 */
    function switchTab(tabName) {
        // 更新 Tab 按钮状态
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // 切换 Tab 内容区
        elements.tabEdit.style.display = tabName === 'edit' ? 'block' : 'none';
        elements.tabInsert.style.display = tabName === 'insert' ? 'block' : 'none';
    }

    // =====================================================
    // 消息处理
    // =====================================================

    function handleMessage(message) {
        const { type, payload } = message;

        switch (type) {
            case 'ELEMENT_SELECTED':
                showElementPanels(payload);
                break;
            case 'EDIT_MODE_CHANGED':
                // Content Script 通知编辑模式变化
                isEditing = payload.isEditing;
                elements.toggleBtn.classList.toggle('active', isEditing);
                elements.toggleText.textContent = isEditing ? '关闭编辑模式' : '开启编辑模式';
                elements.undoBtn.disabled = !isEditing;
                elements.redoBtn.disabled = !isEditing;
                elements.previewBtn.disabled = !isEditing;
                elements.tabBar.style.display = isEditing ? 'flex' : 'none';
                if (!isEditing) {
                    showNoSelection();
                    switchTab('edit');
                }
                break;
        }
    }

    // =====================================================
    // 面板显示
    // =====================================================

    function showNoSelection() {
        elements.noSelection.style.display = 'flex';
        elements.editPanels.style.display = 'none';
        currentElementStyles = null;
    }

    function showElementPanels(payload) {
        elements.noSelection.style.display = 'none';
        elements.editPanels.style.display = 'block';

        currentElementStyles = payload.styles;
        const isMulti = payload.isMultiSelect;

        // 更新元素信息显示状态
        if (isMulti) {
            elements.elementInfoSingle.style.display = 'none';
            elements.elementInfoMulti.style.display = 'flex';
            elements.multiSelectNumber.textContent = payload.selectedCount;
            // 组内布局控件
            elements.layoutSection.style.display = 'block';
            elements.multiSelectGroupOptions.style.display = 'block';
        } else {
            elements.elementInfoSingle.style.display = 'block';
            elements.elementInfoMulti.style.display = 'none';
            elements.elementTag.textContent = payload.tagName;
            elements.elementPath.textContent = payload.path;
            elements.elementPath.title = payload.path;

            // 容器检测
            const isContainer = payload.isContainer || false;
            elements.layoutSection.style.display = isContainer ? 'block' : 'none';
            elements.multiSelectGroupOptions.style.display = 'none';
        }

        // 自动切换到编辑 Tab
        switchTab('edit');

        // 同步控件值
        syncControlsFromStyles(payload.styles);
    }

    /** 将元素的计算样式同步到面板控件 */
    function syncControlsFromStyles(styles) {
        // 获取当前聚焦的控件，防止回写覆盖用户正在输入的内容
        const focused = document.activeElement;

        // 字体（尝试匹配下拉选项）
        if (focused !== elements.fontFamily) {
            const fontOptions = elements.fontFamily.options;
            let fontMatched = false;
            for (let i = 0; i < fontOptions.length; i++) {
                if (styles.fontFamily.includes(fontOptions[i].text)) {
                    elements.fontFamily.selectedIndex = i;
                    fontMatched = true;
                    break;
                }
            }
            if (!fontMatched) {
                elements.fontFamily.selectedIndex = 0;
            }
        }

        // 字号
        if (focused !== elements.fontSize) {
            elements.fontSize.value = parseInt(styles.fontSize) || 16;
        }

        // 文字颜色
        const textColorHex = rgbToHex(styles.color);
        if (focused !== elements.textColor) elements.textColor.value = textColorHex;
        if (focused !== elements.textColorHex) elements.textColorHex.value = textColorHex;

        // 文字样式
        elements.btnBold.classList.toggle('active',
            styles.fontWeight === 'bold' || parseInt(styles.fontWeight) >= 700);
        elements.btnItalic.classList.toggle('active', styles.fontStyle === 'italic');
        elements.btnUnderline.classList.toggle('active', styles.textDecoration.includes('underline'));

        // 文本对齐
        [elements.btnAlignLeft, elements.btnAlignCenter, elements.btnAlignRight].forEach(btn => {
            btn.classList.toggle('active', styles.textAlign === btn.dataset.align);
        });

        // 背景颜色
        const bgColorHex = rgbToHex(styles.backgroundColor);
        if (focused !== elements.bgColor) elements.bgColor.value = bgColorHex;
        if (focused !== elements.bgColorHex) {
            elements.bgColorHex.value = bgColorHex === '#000000' && styles.backgroundColor.includes('rgba(0, 0, 0, 0)')
                ? 'transparent' : bgColorHex;
        }

        // 透明度
        if (focused !== elements.opacity) {
            elements.opacity.value = styles.opacity;
            elements.opacityValue.textContent = styles.opacity;
        }

        // 圆角
        if (focused !== elements.borderRadius) {
            elements.borderRadius.value = parseInt(styles.borderRadius) || 0;
        }

        // 边框
        if (focused !== elements.borderWidth) {
            elements.borderWidth.value = parseInt(styles.borderWidth) || 0;
        }
        if (focused !== elements.borderStyle) {
            const borderStyleValue = styles.borderStyle.split(' ')[0] || 'none';
            elements.borderStyle.value = borderStyleValue;
        }
        if (focused !== elements.borderColor) {
            elements.borderColor.value = rgbToHex(styles.borderColor);
        }

        // 间距
        if (focused !== elements.paddingTop) elements.paddingTop.value = parseInt(styles.paddingTop) || 0;
        if (focused !== elements.paddingRight) elements.paddingRight.value = parseInt(styles.paddingRight) || 0;
        if (focused !== elements.paddingBottom) elements.paddingBottom.value = parseInt(styles.paddingBottom) || 0;
        if (focused !== elements.paddingLeft) elements.paddingLeft.value = parseInt(styles.paddingLeft) || 0;
        if (focused !== elements.marginTop) elements.marginTop.value = parseInt(styles.marginTop) || 0;
        if (focused !== elements.marginRight) elements.marginRight.value = parseInt(styles.marginRight) || 0;
        if (focused !== elements.marginBottom) elements.marginBottom.value = parseInt(styles.marginBottom) || 0;
        if (focused !== elements.marginLeft) elements.marginLeft.value = parseInt(styles.marginLeft) || 0;

        // 布局属性（容器元素同步 display 模式和子选项）
        const displayMode = styles.display || 'block';
        const isFlex = displayMode === 'flex' || displayMode === 'inline-flex';
        const isGrid = displayMode === 'grid' || displayMode === 'inline-grid';

        // 同步 Display 模式按钮
        const displayModeBtns = [elements.btnDisplayBlock, elements.btnDisplayFlex, elements.btnDisplayGrid];
        displayModeBtns.forEach(btn => btn.classList.remove('active'));
        if (isFlex) {
            elements.btnDisplayFlex.classList.add('active');
        } else if (isGrid) {
            elements.btnDisplayGrid.classList.add('active');
        } else {
            elements.btnDisplayBlock.classList.add('active');
        }

        // 切换子选项面板
        elements.flexOptions.style.display = isFlex ? 'block' : 'none';
        elements.gridOptions.style.display = isGrid ? 'block' : 'none';

        // Flex 选项同步
        if (isFlex) {
            const dir = styles.flexDirection || 'row';
            elements.btnFlexRow.classList.toggle('active', dir === 'row' || dir === 'row-reverse');
            elements.btnFlexCol.classList.toggle('active', dir === 'column' || dir === 'column-reverse');

            if (focused !== elements.flexGap) {
                elements.flexGap.value = parseInt(styles.gap) || 0;
            }
            if (focused !== elements.justifyContent) {
                elements.justifyContent.value = styles.justifyContent || 'flex-start';
            }
            if (focused !== elements.alignItems) {
                elements.alignItems.value = styles.alignItems || 'stretch';
            }
            if (focused !== elements.flexWrap) {
                elements.flexWrap.value = styles.flexWrap || 'nowrap';
            }
        }

        // Grid 选项同步
        if (isGrid) {
            // 解析列数
            const gtc = styles.gridTemplateColumns || '';
            const colMatch = gtc.match(/repeat\((\d+)/)
                || (gtc.trim() ? { length: gtc.trim().split(/\s+/).length } : null);
            let colCount = 1;
            if (colMatch && colMatch[1]) {
                colCount = parseInt(colMatch[1]);
            } else if (gtc.trim()) {
                colCount = gtc.trim().split(/\s+/).length;
            }
            document.querySelectorAll('.grid-col-btn').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.cols) === colCount);
            });

            if (focused !== elements.gridGap) {
                elements.gridGap.value = parseInt(styles.gap) || 0;
            }
            if (focused !== elements.gridAlignItems) {
                elements.gridAlignItems.value = styles.alignItems || 'stretch';
            }
        }
    }

    // =====================================================
    // 样式应用
    // =====================================================

    function applyStyle(styles) {
        if (!currentTabId) return;
        safeSendMessage({
            type: 'APPLY_STYLE',
            payload: { tabId: currentTabId, styles }
        });
    }

    function updateBorder() {
        const width = elements.borderWidth.value || '0';
        const style = elements.borderStyle.value;
        const color = elements.borderColor.value;

        if (style === 'none' || width === '0') {
            applyStyle({ border: 'none' });
        } else {
            applyStyle({ border: `${width}px ${style} ${color}` });
        }
    }

    // =====================================================
    // 元素操作
    // =====================================================

    function sendAction(actionType) {
        if (!currentTabId) return;
        safeSendMessage({
            type: actionType,
            payload: { tabId: currentTabId }
        });
    }

    function sendElementAction(action) {
        if (!currentTabId) return;
        safeSendMessage({
            type: 'ELEMENT_ACTION',
            payload: { tabId: currentTabId, action }
        });
        // 操作后重置面板
        showNoSelection();
    }

    // =====================================================
    // 预览原网页
    // =====================================================
    let isPreviewing = false;

    function togglePreviewOriginal() {
        if (!currentTabId) return;

        isPreviewing = !isPreviewing;

        // 更新按钮状态和图标
        const eyeIcon = elements.previewBtn.querySelector('.icon-eye');
        const eyeOffIcon = elements.previewBtn.querySelector('.icon-eye-off');

        if (isPreviewing) {
            elements.previewBtn.classList.add('previewing');
            elements.previewBtn.setAttribute('data-tooltip', "恢复修改（退出预览）");
            elements.previewBtn.removeAttribute('title');
            eyeIcon.style.display = 'none';
            eyeOffIcon.style.display = 'block';
        } else {
            elements.previewBtn.classList.remove('previewing');
            elements.previewBtn.setAttribute('data-tooltip', "对比原文档（预览下无法编辑）");
            elements.previewBtn.removeAttribute('title');
            eyeIcon.style.display = 'block';
            eyeOffIcon.style.display = 'none';
        }

        // 通知 Content Script 切换预览状态
        safeSendMessage({
            type: 'PREVIEW_ORIGINAL',
            payload: { tabId: currentTabId, show: isPreviewing }
        });
    }

    // =====================================================
    // 页面保存与导出
    // =====================================================

    async function getBaseFileName() {
        const tab = await chrome.tabs.get(currentTabId);
        let baseName = 'edited-page';
        if (tab.url) {
            const urlPath = tab.url.replace('file://', '');
            const lastSlash = urlPath.lastIndexOf('/');
            if (lastSlash !== -1) {
                const name = urlPath.substring(lastSlash + 1);
                baseName = name.replace(/\.[^/.]+$/, ""); // Remove extension
                if (!baseName) baseName = 'edited-page';
            }
        }
        return baseName;
    }

    async function saveHtmlPage() {
        if (!currentTabId) {
            console.error('PageForge: No currentTabId');
            return;
        }

        const originalBtnText = elements.btnSaveHtml.innerHTML;
        try {
            elements.btnSaveHtml.innerHTML = '<span>处理中...</span>';
            elements.btnSaveHtml.disabled = true;

            const baseName = await getBaseFileName();
            const fileName = `${baseName}.html`;

            console.log('PageForge: Requesting HTML from content script...');
            safeSendMessage({
                type: 'GET_PAGE_HTML',
                payload: { tabId: currentTabId }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('PageForge: Runtime error:', chrome.runtime.lastError.message);
                    alert('无法获取页面数据：' + chrome.runtime.lastError.message);
                    elements.btnSaveHtml.innerHTML = originalBtnText;
                    elements.btnSaveHtml.disabled = false;
                    return;
                }

                if (response && response.html) {
                    console.log('PageForge: Received HTML, initiating download...');
                    safeSendMessage({
                        type: 'SAVE_PAGE',
                        payload: { content: response.html, fileName, mimeType: 'text/html' }
                    }, (saveResponse) => {
                        elements.btnSaveHtml.innerHTML = originalBtnText;
                        elements.btnSaveHtml.disabled = false;
                        if (chrome.runtime.lastError) {
                            console.error('PageForge: Save error:', chrome.runtime.lastError.message);
                        }
                    });
                } else {
                    console.error('PageForge: Content script returned empty HTML');
                    alert('导出失败：内容脚本未返回数据。请尝试刷新页面。');
                    elements.btnSaveHtml.innerHTML = originalBtnText;
                    elements.btnSaveHtml.disabled = false;
                }
            });
        } catch (error) {
            console.error('PageForge: Unexpected error during HTML export:', error);
            alert('导出发生意外错误，请查看控制台日志。');
            elements.btnSaveHtml.innerHTML = originalBtnText;
            elements.btnSaveHtml.disabled = false;
        }
    }

    async function exportCssPatch() {
        if (!currentTabId) return;

        const originalBtnText = elements.btnSaveCss.innerHTML;
        try {
            elements.btnSaveCss.innerHTML = '处理中...';
            elements.btnSaveCss.disabled = true;

            const baseName = await getBaseFileName();
            const fileName = `${baseName}-patch.css`;

            safeSendMessage({
                type: 'GET_CSS_PATCH',
                payload: { tabId: currentTabId }
            }, (response) => {
                elements.btnSaveCss.innerHTML = originalBtnText;
                elements.btnSaveCss.disabled = false;

                if (response && response.css) {
                    safeSendMessage({
                        type: 'SAVE_PAGE',
                        payload: { content: response.css, fileName, mimeType: 'text/css' }
                    });
                } else {
                    alert('没有检测到任何样式修改。');
                }
            });
        } catch (error) {
            console.error('PageForge: CSS export error:', error);
            elements.btnSaveCss.innerHTML = originalBtnText;
            elements.btnSaveCss.disabled = false;
        }
    }

    async function exportActionLog() {
        if (!currentTabId) return;

        const originalBtnText = elements.btnSaveJson.innerHTML;
        try {
            elements.btnSaveJson.innerHTML = '处理中...';
            elements.btnSaveJson.disabled = true;

            const baseName = await getBaseFileName();
            const fileName = `${baseName}-actions.json`;

            safeSendMessage({
                type: 'GET_ACTION_LOG',
                payload: { tabId: currentTabId }
            }, (response) => {
                elements.btnSaveJson.innerHTML = originalBtnText;
                elements.btnSaveJson.disabled = false;

                if (response && response.json) {
                    safeSendMessage({
                        type: 'SAVE_PAGE',
                        payload: { content: response.json, fileName, mimeType: 'application/json' }
                    });
                } else {
                    alert('没有检测到任何操作记录。');
                }
            });
        } catch (error) {
            console.error('PageForge: Action log export error:', error);
            elements.btnSaveJson.innerHTML = originalBtnText;
            elements.btnSaveJson.disabled = false;
        }
    }

    // =====================================================
    // 辅助函数
    // =====================================================

    /** 将 RGB/RGBA 颜色字符串转换为 HEX 格式 */
    function rgbToHex(rgb) {
        if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') {
            return '#000000';
        }
        // 如果已经是 hex 格式直接返回
        if (rgb.startsWith('#')) {
            return rgb.length === 4
                ? '#' + rgb[1] + rgb[1] + rgb[2] + rgb[2] + rgb[3] + rgb[3]
                : rgb;
        }
        // 解析 rgb() 或 rgba()
        const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return '#000000';

        const r = parseInt(match[1]);
        const g = parseInt(match[2]);
        const b = parseInt(match[3]);
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    /** 标准化颜色输入（支持 #RGB, #RRGGBB 格式） */
    function normalizeColor(value) {
        const hex = value.trim();
        if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
            return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        }
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
            return hex;
        }
        // 尝试无 # 前缀
        if (/^[0-9a-fA-F]{3}$/.test(hex)) {
            return '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
            return '#' + hex;
        }
        return null;
    }

    // =====================================================
    // 启动与悬停提示
    // =====================================================

    init();

    // =====================================================
    // 全局悬停提示 (1秒延迟)
    // =====================================================
    const tooltipEl = document.createElement('div');
    tooltipEl.className = 'global-tooltip';
    document.body.appendChild(tooltipEl);

    let tooltipTimeout;

    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[title], [data-tooltip]');
        if (!target) return;

        // 转换 native title 为 data-tooltip，截获原生提示
        if (target.hasAttribute('title')) {
            target.setAttribute('data-tooltip', target.getAttribute('title'));
            target.removeAttribute('title');
        }

        const tooltipText = target.getAttribute('data-tooltip');
        if (!tooltipText) return;

        clearTimeout(tooltipTimeout);

        tooltipTimeout = setTimeout(() => {
            tooltipEl.textContent = tooltipText;
            const rect = target.getBoundingClientRect();

            // 默认显示在正下方
            let top = rect.bottom + 6;
            let left = rect.left + rect.width / 2;

            tooltipEl.style.top = `${top}px`;
            tooltipEl.style.left = `${left}px`;
            tooltipEl.style.transform = `translateX(-50%)`;

            tooltipEl.classList.add('show');

            // 确保不溢出屏幕
            requestAnimationFrame(() => {
                const tr = tooltipEl.getBoundingClientRect();
                if (tr.right > window.innerWidth - 4) {
                    tooltipEl.style.left = `${window.innerWidth - 8}px`;
                    tooltipEl.style.transform = `translateX(-100%)`;
                } else if (tr.left < 4) {
                    tooltipEl.style.left = `8px`;
                    tooltipEl.style.transform = `translateX(0)`;
                }

                if (tr.bottom > window.innerHeight - 4) {
                    tooltipEl.style.top = `${rect.top - tr.height - 6}px`;
                }
            });
        }, 1000); // 1秒延迟
    });

    document.addEventListener('mouseout', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
            // 防抖：移动到内部子元素时不算移出
            if (e.relatedTarget && target.contains(e.relatedTarget)) return;
            clearTimeout(tooltipTimeout);
            tooltipEl.classList.remove('show');
        }
    });

    document.addEventListener('mousedown', () => {
        clearTimeout(tooltipTimeout);
        tooltipEl.classList.remove('show');
    });

})();
