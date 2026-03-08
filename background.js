// PageForge Background Service Worker
// 管理编辑模式状态，中转 Content Script 与 Side Panel 之间的消息

// 点击插件图标时打开 Side Panel
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// 允许 Side Panel 在所有页面显示
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// 维护每个 tab 的编辑状态
const tabEditState = new Map();

// 维护被 debugger 附加的 tab 列表
const attachedDebuggers = new Set();

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    attachedDebuggers.delete(source.tabId);
  }
});

// 消息路由：在 Content Script 和 Side Panel 之间中转消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    // Side Panel → Content Script：切换编辑模式
    case 'TOGGLE_EDIT_MODE': {
      const tabId = payload.tabId;
      const isEditing = payload.isEditing;
      tabEditState.set(tabId, isEditing);
      chrome.tabs.sendMessage(tabId, { type: 'SET_EDIT_MODE', payload: { isEditing } }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：应用样式变更
    case 'APPLY_STYLE': {
      chrome.tabs.sendMessage(payload.tabId, {
        type: 'APPLY_STYLE',
        payload: payload.styles
      }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：元素操作（隐藏/删除）
    case 'ELEMENT_ACTION': {
      chrome.tabs.sendMessage(payload.tabId, {
        type: 'ELEMENT_ACTION',
        payload: { action: payload.action }
      }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：添加元素
    case 'ADD_ELEMENT': {
      chrome.tabs.sendMessage(payload.tabId, {
        type: 'ADD_ELEMENT',
        payload: { elementType: payload.elementType }
      }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Side Panel → Content Script：撤销/重做/对比
    case 'UNDO':
    case 'REDO':
    case 'PREVIEW_ORIGINAL': {
      chrome.tabs.sendMessage(payload.tabId, { type, payload }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Content Script → Side Panel：选中元素的样式信息
    case 'ELEMENT_SELECTED': {
      // 广播给所有扩展页面（Side Panel 会监听）
      chrome.runtime.sendMessage({
        type: 'ELEMENT_SELECTED',
        payload: message.payload
      }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Content Script → Side Panel：编辑模式状态变更
    case 'EDIT_MODE_CHANGED': {
      chrome.runtime.sendMessage({
        type: 'EDIT_MODE_CHANGED',
        payload: message.payload
      }, () => void chrome.runtime.lastError);
      sendResponse({ success: true });
      break;
    }

    // Side Panel -> Background: 获取特定 tab 的编辑状态
    case 'GET_EDIT_MODE_STATE': {
      const isEditing = tabEditState.get(payload.tabId) || false;
      sendResponse({ isEditing });
      break;
    }

    // Side Panel → Content Script：获取页面 HTML（用于保存）
    case 'GET_PAGE_HTML': {
      chrome.tabs.sendMessage(payload.tabId, { type: 'GET_PAGE_HTML', payload: {} }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ html: null });
        } else {
          sendResponse(response);
        }
      });
      return true; // 异步响应
    }

    // Side Panel → Content Script：获取 CSS Patch
    case 'GET_CSS_PATCH': {
      chrome.tabs.sendMessage(payload.tabId, { type: 'GET_CSS_PATCH', payload: {} }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ css: null });
        } else {
          sendResponse(response);
        }
      });
      return true; // 异步响应
    }

    // Side Panel → Content Script：获取 Action Log
    case 'GET_ACTION_LOG': {
      chrome.tabs.sendMessage(payload.tabId, { type: 'GET_ACTION_LOG', payload: {} }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ json: null });
        } else {
          sendResponse(response);
        }
      });
      return true; // 异步响应
    }

    // Side Panel：保存页面或导出文件
    case 'SAVE_PAGE': {
      try {
        const fileContent = payload.content || payload.html;
        const fileName = payload.fileName || 'edited-page.html';
        const mimeType = payload.mimeType || 'text/html';

        // 在 MV3 Service Worker 中无法使用 URL.createObjectURL
        // 改用 Data URL (Base64)
        const base64Content = btoa(unescape(encodeURIComponent(fileContent)));
        const dataUrl = `data:${mimeType};base64,${base64Content}`;

        chrome.downloads.download({
          url: dataUrl,
          filename: fileName,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('Download failed:', chrome.runtime.lastError.message);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, downloadId });
          }
        });
      } catch (err) {
        console.error('Error in SAVE_PAGE:', err);
        sendResponse({ success: false, error: err.message });
      }
      return true; // 异步响应
    }

    // Side Panel -> Background: 切换视口模拟
    case 'SET_VIEWPORT': {
      const tabId = payload.tabId;
      const width = payload.width;
      const debuggeeId = { tabId: tabId };

      if (width === 'default') {
        // 恢复默认桌面端
        if (attachedDebuggers.has(tabId)) {
          chrome.debugger.detach(debuggeeId, () => {
            attachedDebuggers.delete(tabId);
            sendResponse({ success: true });
          });
        } else {
          sendResponse({ success: true });
        }
        return true;
      }

      const setDeviceMetrics = () => {
        chrome.debugger.sendCommand(
          debuggeeId,
          "Emulation.setDeviceMetricsOverride",
          {
            width: width,
            height: 0,
            deviceScaleFactor: 0,
            mobile: width <= 768
          },
          () => {
            if (chrome.runtime.lastError) {
              console.error('Debugger Error (setDeviceMetrics):', chrome.runtime.lastError.message);
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ success: true });
            }
          }
        );
      };

      if (!attachedDebuggers.has(tabId)) {
        chrome.debugger.attach(debuggeeId, "1.3", () => {
          if (chrome.runtime.lastError) {
            console.error('Debugger Error (attach):', chrome.runtime.lastError.message);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            attachedDebuggers.add(tabId);
            setDeviceMetrics();
          }
        });
      } else {
        setDeviceMetrics();
      }
      return true;
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

// 清理导航更新/刷新的 tab 状态
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabEditState.set(tabId, false);
  }
});
