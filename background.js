// WebEdit Background Service Worker
// 管理编辑模式状态，中转 Content Script 与 Side Panel 之间的消息

// 点击插件图标时打开 Side Panel
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// 允许 Side Panel 在所有页面显示
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// 维护每个 tab 的编辑状态
const tabEditState = new Map();

// 消息路由：在 Content Script 和 Side Panel 之间中转消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    // Side Panel → Content Script：切换编辑模式
    case 'TOGGLE_EDIT_MODE': {
      const tabId = payload.tabId;
      const isEditing = payload.isEditing;
      tabEditState.set(tabId, isEditing);
      chrome.tabs.sendMessage(tabId, { type: 'SET_EDIT_MODE', payload: { isEditing } });
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：应用样式变更
    case 'APPLY_STYLE': {
      chrome.tabs.sendMessage(payload.tabId, {
        type: 'APPLY_STYLE',
        payload: payload.styles
      });
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：元素操作（隐藏/删除）
    case 'ELEMENT_ACTION': {
      chrome.tabs.sendMessage(payload.tabId, {
        type: 'ELEMENT_ACTION',
        payload: { action: payload.action }
      });
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：添加元素
    case 'ADD_ELEMENT': {
      chrome.tabs.sendMessage(payload.tabId, {
        type: 'ADD_ELEMENT',
        payload: { elementType: payload.elementType }
      });
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：撤销/重做
    case 'UNDO':
    case 'REDO': {
      chrome.tabs.sendMessage(payload.tabId, { type, payload: {} });
      sendResponse({ success: true });
      break;
    }

    // Content Script → Side Panel：选中元素的样式信息
    case 'ELEMENT_SELECTED': {
      // 广播给所有扩展页面（Side Panel 会监听）
      chrome.runtime.sendMessage({
        type: 'ELEMENT_SELECTED',
        payload: message.payload
      }).catch(() => {
        // Side Panel 可能未打开，忽略错误
      });
      sendResponse({ success: true });
      break;
    }

    // Content Script → Side Panel：编辑模式状态变更
    case 'EDIT_MODE_CHANGED': {
      chrome.runtime.sendMessage({
        type: 'EDIT_MODE_CHANGED',
        payload: message.payload
      }).catch(() => { });
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：获取页面 HTML（用于保存）
    case 'GET_PAGE_HTML': {
      chrome.tabs.sendMessage(payload.tabId, { type: 'GET_PAGE_HTML', payload: {} }, (response) => {
        sendResponse(response);
      });
      return true; // 异步响应
    }

    // Side Panel：保存页面为 HTML 文件
    case 'SAVE_PAGE': {
      const htmlContent = payload.html;
      const fileName = payload.fileName || 'edited-page.html';
      // 创建 Blob URL 用于下载
      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({
        url: url,
        filename: fileName,
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
        sendResponse({ success: true });
      });
      return true; // 异步响应
    }

    default:
      break;
  }

  return false;
});

// 清理已关闭 tab 的状态
chrome.tabs.onRemoved.addListener((tabId) => {
  tabEditState.delete(tabId);
});
