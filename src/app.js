// - 核心理由：PWA 應用程式引導與生命週期管理器，此版本全面移除了 FAB 浮動按鈕的點擊綁定，改為由 ui.js 中鍵與頂部 App Bar 說明按鈕事件進行驅動。
// - 權責邊界：[負責] 協調 Auth、Firestore 訂閱與 UI 觸發；註冊 PWA sw.js。 [不負責] 核心商業判定與 DOM 片段生成。
// - MWE：在 index.html 載入後，配合 DOM 元素與修補版 Firebase 模組自動初始化。
// - 致命錯誤邊界：切換分頁或登出時，若未徹底退訂（unsubscribe）舊監聽，將會造成資料流重疊與讀取次數飆升；此處採用單一 unsub 結構並在 auth 變更時主動清空，風險受控。

import { appState, setCurrentUser, setCards, setLogs } from "./state.js";
import { listenAuth, login, logout } from "./auth.js";
import { createCard, subscribeCards, subscribeLogs } from "./firestore.js";
import {
  dom,
  renderAuthStates,
  renderStats,
  renderCards,
  renderLogs,
  openSheet,
  closeSheet,
  updateCounter,
  showToast
} from "./ui.js";

// ==========================================
// 1. 全域資料訂閱生命週期管理
// ==========================================
let unsubCards = null;
let unsubLogs = null;

/**
 * 徹底退訂所有 Firestore 即時連線，防止記憶體與計費次數洩漏
 */
function cleanupSubscriptions() {
  if (unsubCards) {
    unsubCards();
    unsubCards = null;
  }
  if (unsubLogs) {
    unsubLogs();
    unsubLogs = null;
  }
}

/**
 * 根據當前 tab 建立精確的即時數據訂閱
 */
function setupSubscriptions() {
  const user = appState.currentUser;
  const userData = appState.currentUserDoc;
  if (!user || !userData) return;

  // 1. 徹底退訂上一次的連線
  cleanupSubscriptions();

  // 2. 依據 Tab 模式建立新連線
  if (appState.currentTab === "ended") {
    // 訂閱已結束卡片
    unsubCards = subscribeCards("ended", user.uid, (cardsList) => {
      setCards(cardsList);
      renderStats();
      renderCards();
    });
  } else if (appState.currentTab === "logs") {
    // 訂閱系統操作紀錄
    unsubLogs = subscribeLogs((logsList) => {
      setLogs(logsList);
      renderLogs();
    });
  } else {
    // 預設 "all" 或 "mine" 均訂閱 active 狀態卡片 (ended == false)
    // 藉由同一組即時連線，UI 透過記憶體過濾我建立的卡片，節省 50% 的 Firestore 讀取量！
    unsubCards = subscribeCards("all", user.uid, (cardsList) => {
      setCards(cardsList);
      renderStats();
      renderCards();
    });
  }
}

// ==========================================
// 2. DOM 點擊事件與操作綁定
// ==========================================

function bindDOMEvents() {
  // 登入按鈕點擊
  dom.loginBtn.onclick = async () => {
    try {
      dom.loginBtn.disabled = true;
      showToast("正在導向 Google 登入...");
      await login();
    } catch (err) {
      dom.loginBtn.disabled = false;
      showToast("登入失敗：" + err.message);
    }
  };

  // 登出按鈕點擊
  dom.logoutBtn.onclick = async () => {
    try {
      await logout();
      showToast("已成功安全登出");
    } catch (err) {
      showToast("登出失敗：" + err.message);
    }
  };

  // 💡 方案 A 改進：全域頂部說明按鈕點擊事件綁定
  dom.infoBtn.onclick = () => {
    const roleText = appState.currentUserDoc?.role === "manage" 
      ? "管理權限：可以建立卡片、收起任意卡片，並恢復已被收起的卡片。" 
      : "協作權限：可以建立卡片、對任意卡片留言協作，並將自己建立的卡片標記為完成或收起。";
    showToast(roleText);
  };

  // 新增卡片面板開關與遮罩綁定
  dom.cancel.onclick = () => closeSheet();
  dom.mask.onclick = () => closeSheet();

  // 新增卡片字數計算提示
  dom.newTitle.oninput = () => updateCounter();
  dom.newBody.oninput = () => updateCounter();

  // 新增卡片提交處理
  dom.newCard.onsubmit = async (e) => {
    e.preventDefault();
    const title = dom.newTitle.value.trim();
    const body = dom.newBody.value.trim();

    if (!title) {
      showToast("卡片名稱不可為空");
      return;
    }

    const submitBtn = dom.newCard.querySelector("button[type='submit']");
    submitBtn.disabled = true;

    try {
      await createCard(title, body, appState.currentUser, appState.currentUserDoc);
      closeSheet();
      showToast("新增卡片成功");
    } catch (err) {
      console.error("App: Create card failed", err);
      showToast("寫入失敗：" + err.message);
    } finally {
      submitBtn.disabled = false;
    }
  };

  // 監聽來自 ui.js 分頁切換的自定義事件
  window.addEventListener("tab-changed", () => {
    setupSubscriptions();
  });
}

// ==========================================
// 3. PWA Service Worker 註冊與更新檢查
// ==========================================
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      // 支援部署於 GitHub Pages 專案子目錄 "./sw.js"
      navigator.serviceWorker.register("./sw.js")
        .then((reg) => {
          reg.onupdatefound = () => {
            const installingWorker = reg.installing;
            if (installingWorker) {
              installingWorker.onstatechange = () => {
                if (installingWorker.state === "installed") {
                  if (navigator.serviceWorker.controller) {
                    showToast("系統有新版本！請重啟應用程式以載入。");
                  } else {
                    console.log("App: Service Worker 註冊成功，已啟用離線快取。");
                  }
                }
              };
            }
          };
        })
        .catch((err) => {
          console.warn("App: Service Worker registration failed", err);
        });
    });
  }
}

// ==========================================
// 4. 系統安全啟動機制
// ==========================================
function initApp() {
  // 1. 綁定 DOM 靜態事件
  bindDOMEvents();

  // 2. 註冊 Service Worker
  registerServiceWorker();

  // 3. 啟動 Firebase 認證監聽通道 (修補：支援白名單阻斷與錯誤訊息彈跳提示)
  listenAuth((user, userData, errMessage) => {
    // 當認證狀態改變，主動釋放既有訂閱
    cleanupSubscriptions();
    
    setCurrentUser(user, userData);
    renderAuthStates();

    if (user && userData) {
      // 成功通過白名單授權驗證
      appState.currentTab = "all";
      appState.selectedCardId = null;
      
      // 建立對應分頁的即時訂閱資料流
      setupSubscriptions();
      showToast(`歡迎回來，${userData.displayName || "協作者"}`);
    } else {
      // 未授權狀態或非白名單用戶：清空本地卡片與紀錄快取
      setCards([]);
      setLogs([]);
      dom.loginBtn.disabled = false; // 重新啟用登入按鈕
      
      // 若因非白名單遭到阻斷，於畫面彈跳 Toast 警告
      if (errMessage) {
        showToast(errMessage);
      }
    }
  });
}

// 執行系統初始化
initApp();
