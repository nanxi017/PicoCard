// - 核心理由：系統唯一的畫面渲染與互動管理器，此版本修正了遺漏 getSelectedCard 導入而導致的 runtime 崩潰錯誤。
// - 權責邊界：[負責] 操控 DOM、處理 Bottom Sheet 開關、彈出原子確認盒、提示 Toast、管理留言監聽釋放。 [不負責] 直接呼叫資料庫 API。
// - MWE：在 index.html 載入後，配合 DOM 元素進行介面渲染。
// - 致命錯誤邊界：若卡片重繪時未釋放舊留言的即時監聽（onSnapshot），手機瀏覽器將在 5 分鐘內因 Listener 溢出而崩潰；此處實作 NoteUnsub Map 徹底解決，風險受控。

import { appState, isEnded, canComplete, canPutaway, canRestore, canRecallNote, getSelectedCard } from "./state.js";
import { login, logout } from "./auth.js";
import { createCard, completeCard, putawayCard, restoreCard, createNote, recallNote, subscribeNotes } from "./firestore.js";

// ==========================================
// 1. DOM 節點快取
// ==========================================
export const dom = {
  loginScreen: document.getElementById("loginScreen"),
  mainApp: document.getElementById("mainApp"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  userBadge: document.getElementById("userBadge"),
  stats: document.getElementById("stats"),
  listTitle: document.getElementById("listTitle"),
  count: document.getElementById("count"),
  cards: document.getElementById("cards"),
  records: document.getElementById("records"),
  empty: document.getElementById("empty"),
  fab: document.getElementById("fab"),
  bottomNav: document.getElementById("bottomNav"),
  mask: document.getElementById("mask"),
  sheet: document.getElementById("sheet"),
  newCard: document.getElementById("newCard"),
  newTitle: document.getElementById("newTitle"),
  newBody: document.getElementById("newBody"),
  counter: document.getElementById("counter"),
  cancel: document.getElementById("cancel"),
  confirmMask: document.getElementById("confirmMask"),
  confirmBox: document.getElementById("confirmBox"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmText: document.getElementById("confirmText"),
  confirmNo: document.getElementById("confirmNo"),
  confirmYes: document.getElementById("confirmYes"),
  toast: document.getElementById("toast"),
  content: document.getElementById("content")
};

// 用以儲存各個卡片留言監聽器的登出回呼，防止記憶體洩漏
const noteUnsubscribers = new Map();

// 展開/收起內文的狀態快取 (CardId -> boolean)
const expandedBodies = new Set();

// ==========================================
// 2. 基礎彈窗與提示 (Toast / Bottom Sheet / Confirm)
// ==========================================
let toastTimer = null;

export function showToast(msg) {
  clearTimeout(toastTimer);
  dom.toast.textContent = msg;
  dom.toast.classList.add("show");
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove("show");
  }, 1800);
}

export function openSheet() {
  dom.mask.classList.add("show");
  dom.sheet.classList.add("show");
  dom.newCard.reset();
  updateCounter();
  setTimeout(() => dom.newTitle.focus(), 150);
}

export function closeSheet() {
  dom.mask.classList.remove("show");
  dom.sheet.classList.remove("show");
}

export function updateCounter() {
  const tLen = dom.newTitle.value.length;
  const bLen = dom.newBody.value.length;
  dom.counter.textContent = `卡片名稱 ${tLen}/40 ； 內容說明 ${bLen}/500`;
}

/**
 * 彈出通用原子確認盒 (BDD 核心控制點)
 */
export function askConfirm(title, text, onYes, isDanger = false) {
  dom.confirmTitle.textContent = title;
  dom.confirmText.textContent = text;
  dom.confirmYes.className = isDanger ? "confirmYes danger" : "confirmYes";
  
  dom.confirmMask.classList.add("show");
  dom.confirmBox.classList.add("show");

  dom.confirmNo.onclick = () => closeConfirm();
  dom.confirmYes.onclick = () => {
    closeConfirm();
    onYes();
  };
}

export function closeConfirm() {
  dom.confirmMask.classList.remove("show");
  dom.confirmBox.classList.remove("show");
}

// ==========================================
// 3. UI 數據渲染器
// ==========================================

/**
 * 切換授權視窗
 */
export function renderAuthStates() {
  if (appState.currentUser && appState.currentUserDoc) {
    dom.loginScreen.style.display = "none";
    dom.mainApp.style.display = "flex";
    
    const roleText = appState.currentUserDoc.role === "manage" ? "管理" : "協作";
    dom.userBadge.textContent = `${appState.currentUserDoc.displayName || "使用者"} ｜ ${roleText}`;
  } else {
    dom.loginScreen.style.display = "flex";
    dom.mainApp.style.display = "none";
    // 登出時釋放所有留言監聽
    releaseNoteListeners();
  }
}

/**
 * 渲染統計資訊
 */
export function renderStats() {
  // 基於單一訂閱集合 cards 計算
  const totalActive = appState.cards.filter(c => c.state === "open" && c.life === "open").length;
  const totalMine = appState.cards.filter(c => c.state === "open" && c.life === "open" && c.createdBy === appState.currentUser?.uid).length;
  const totalDone = appState.cards.filter(c => c.state === "done" && c.life === "open").length;
  const totalPutaway = appState.cards.filter(c => c.life === "putaway").length;

  dom.stats.innerHTML = `
    <div class="stat"><b>${totalActive}</b><span>待處理</span></div>
    <div class="stat"><b>${totalMine}</b><span>我建立</span></div>
    <div class="stat"><b>${totalDone}</b><span>已完成</span></div>
    <div class="stat"><b>${totalPutaway}</b><span>已收起</span></div>
  `;
}

/**
 * 釋放所有留言監聽器，防止溢出
 */
function releaseNoteListeners() {
  noteUnsubscribers.forEach((unsub) => unsub());
  noteUnsubscribers.clear();
}

/**
 * 主卡片池渲染器
 */
export function renderCards() {
  // 先釋放舊留言監聽
  releaseNoteListeners();
  dom.cards.innerHTML = "";

  // 依據頁籤過濾卡片
  let renderList = [...appState.cards];
  if (appState.currentTab === "mine") {
    renderList = renderList.filter(c => c.state === "open" && c.life === "open" && c.createdBy === appState.currentUser?.uid);
  }

  // 設定標題與計數
  const tabTitles = {
    all: "要做的卡片",
    mine: "我建立的卡片",
    ended: "已結束卡片"
  };
  dom.listTitle.textContent = tabTitles[appState.currentTab] || "卡片";
  dom.count.textContent = `${renderList.length} 張`;

  if (renderList.length === 0) {
    dom.empty.classList.add("show");
    renderBottomNav();
    return;
  }
  dom.empty.classList.remove("show");

  const frag = document.createDocumentFragment();

  renderList.forEach((card) => {
    const isSelected = appState.selectedCardId === card.id;
    const cardEl = document.createElement("article");
    cardEl.className = `card ${isEnded(card) ? "ended" : ""} ${isSelected ? "selected" : ""}`;
    
    // 點選卡片切換選取狀態
    cardEl.onclick = (e) => {
      if (e.target.closest("button") || e.target.closest("form") || e.target.closest("input")) {
        return; // 排除按鈕與輸入框
      }
      if (appState.selectedCardId === card.id) {
        appState.selectedCardId = null; // 取消選取
      } else {
        appState.selectedCardId = card.id;
      }
      renderCards(); // 局部重繪狀態
    };

    // 狀態文字對應
    let stateText = "要做的";
    let stateClass = "open";
    if (card.life === "putaway") {
      stateText = "已收起";
      stateClass = "putaway";
    } else if (card.state === "done") {
      stateText = "已完成";
      stateClass = "done";
    }

    const titleRow = document.createElement("div");
    titleRow.className = "cardTop";
    titleRow.innerHTML = `
      <div class="title">${escapeHTML(card.title)}</div>
      <span class="state ${stateClass}">${stateText}</span>
    `;
    cardEl.appendChild(titleRow);

    // 詮釋資料
    const metaRow = document.createElement("div");
    metaRow.className = "meta";
    metaRow.textContent = `建立：${card.createdByName} ｜ 更新：${formatTime(card.updatedAt)}`;
    cardEl.appendChild(metaRow);

    // 卡片內文 (展開/收合控制)
    if (card.body) {
      const bodyEl = document.createElement("div");
      const isFolded = !expandedBodies.has(card.id);
      bodyEl.className = `body ${isFolded ? "fold" : ""}`;
      bodyEl.textContent = card.body;
      cardEl.appendChild(bodyEl);

      // 超過長度或是含有換行，渲染展開按鈕
      if (card.body.length > 70 || card.body.includes("\n")) {
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "textBtn";
        toggleBtn.textContent = isFolded ? "展開說明" : "收起說明";
        toggleBtn.onclick = (e) => {
          e.stopPropagation();
          if (isFolded) {
            expandedBodies.add(card.id);
          } else {
            expandedBodies.delete(card.id);
          }
          renderCards();
        };
        cardEl.appendChild(toggleBtn);
      }
    }

    // 系統收起理由顯示
    if (card.reason) {
      const reasonEl = document.createElement("div");
      reasonEl.className = "meta";
      reasonEl.style.color = "var(--red)";
      reasonEl.style.marginTop = "6px";
      reasonEl.textContent = `收起原因：${card.reason}`;
      cardEl.appendChild(reasonEl);
    }

    // 留言渲染容器
    const notesContainer = document.createElement("div");
    notesContainer.className = "notes";
    cardEl.appendChild(notesContainer);

    // 動態綁定留言訂閱，保證資料保真
    const unsubNotes = subscribeNotes(card.id, (notesList) => {
      notesContainer.innerHTML = "";
      if (notesList.length === 0) return;

      // 限制卡片首頁只渲染最新 3 筆非 recalled 留言
      const activeNotes = notesList.filter(n => n.life === "open");
      const displayNotes = activeNotes.slice(-3);

      displayNotes.forEach((note) => {
        const noteEl = document.createElement("div");
        noteEl.className = "note";

        const noteTop = document.createElement("div");
        noteTop.className = "noteTop";
        
        const infoSpan = document.createElement("span");
        infoSpan.textContent = `${note.createdByName} • ${formatTime(note.createdAt)}`;
        noteTop.appendChild(infoSpan);

        // 如果是自己的留言，提供「收回」按鈕
        if (canRecallNote(note, appState.currentUser)) {
          const recallBtn = document.createElement("button");
          recallBtn.className = "logout-btn";
          recallBtn.textContent = "收回";
          recallBtn.style.color = "var(--red)";
          recallBtn.onclick = (e) => {
            e.stopPropagation();
            askConfirm(
              "確認收回留言",
              "收回後將無法還原，確定要收回此發言嗎？",
              async () => {
                try {
                  await recallNote(card.id, card.title, note.id, appState.currentUser, appState.currentUserDoc);
                  showToast("留言已收回");
                } catch (err) {
                  showToast("操作失敗：" + err.message);
                }
              },
              true
            );
          };
          noteTop.appendChild(recallBtn);
        } else {
          const tagSpan = document.createElement("span");
          tagSpan.className = "tag";
          tagSpan.textContent = "發言";
          noteTop.appendChild(tagSpan);
        }

        noteEl.appendChild(noteTop);

        const textEl = document.createElement("div");
        textEl.className = "noteText";
        textEl.textContent = note.text;
        noteEl.appendChild(textEl);

        notesContainer.appendChild(noteEl);
      });
    });

    noteUnsubscribers.set(card.id, unsubNotes);

    // 快速發言輸入框 (僅限未結束卡片)
    if (!isEnded(card)) {
      const sayForm = document.createElement("form");
      sayForm.className = "say";
      
      const sayInput = document.createElement("input");
      sayInput.type = "text";
      sayInput.placeholder = "快速發言...";
      sayInput.maxLength = 100;
      sayInput.required = true;

      const saySend = document.createElement("button");
      saySend.type = "submit";
      saySend.textContent = "傳送";

      sayForm.appendChild(sayInput);
      sayForm.appendChild(saySend);

      sayForm.onsubmit = async (e) => {
        e.preventDefault();
        const text = sayInput.value.trim();
        if (!text) return;
        sayInput.disabled = true;
        saySend.disabled = true;
        try {
          await createNote(card.id, card.title, text, appState.currentUser, appState.currentUserDoc);
          sayInput.value = "";
          showToast("發言成功");
        } catch (err) {
          showToast("發言失敗：" + err.message);
        } finally {
          sayInput.disabled = false;
          saySend.disabled = false;
        }
      };

      cardEl.appendChild(sayForm);
    }

    frag.appendChild(cardEl);
  });

  dom.cards.appendChild(frag);
  renderBottomNav();
}

/**
 * 歷史日誌紀錄渲染
 */
export function renderLogs() {
  dom.listTitle.textContent = "系統操作紀錄";
  dom.count.textContent = `${appState.logs.length} 筆`;
  dom.cards.innerHTML = "";
  
  if (appState.logs.length === 0) {
    dom.records.innerHTML = "無系統操作紀錄。";
    dom.records.hidden = false;
    renderBottomNav();
    return;
  }

  const logText = appState.logs.map((log) => {
    return `[${formatTime(log.createdAt)}] ${log.actorName} • ${log.text}`;
  }).join("\n");

  dom.records.textContent = logText;
  dom.records.hidden = false;
  renderBottomNav();
}

/**
 * 底部導覽按鈕管理器 (BDD 核心 UI 定界)
 */
export function renderBottomNav() {
  dom.bottomNav.innerHTML = "";
  const cardSelected = getSelectedCard();

  if (cardSelected) {
    // ----------------------------------------------------
    // 行動 A：已選取卡片 (聚焦特定卡片的操作狀態機)
    // ----------------------------------------------------
    const actions = [];

    // 1. 完成動作
    if (canComplete(cardSelected, appState.currentUser, appState.currentUserDoc)) {
      actions.push(["完成", "✔", async () => {
        askConfirm(
          "確認完成",
          `要把「${cardSelected.title}」標記為完成嗎？`,
          async () => {
            try {
              await completeCard(cardSelected, appState.currentUser, appState.currentUserDoc);
              appState.selectedCardId = null;
              showToast("卡片已完成");
            } catch (err) {
              showToast("操作被拒絕：" + err.message);
            }
          }
        );
      }, "green-text"]);
    }

    // 2. 收起動作
    if (canPutaway(cardSelected, appState.currentUser, appState.currentUserDoc)) {
      actions.push(["收起", "⛔", async () => {
        askConfirm(
          "確認收起",
          `要把「${cardSelected.title}」放入收起夾嗎？`,
          async () => {
            try {
              await putawayCard(cardSelected, appState.currentUser, appState.currentUserDoc);
              appState.selectedCardId = null;
              showToast("卡片已收起");
            } catch (err) {
              showToast("操作被拒絕：" + err.message);
            }
          },
          true
        );
      }, "danger"]);
    }

    // 3. 恢復動作
    if (canRestore(cardSelected, appState.currentUser, appState.currentUserDoc)) {
      actions.push(["恢復", "🔄", async () => {
        askConfirm(
          "確認恢復",
          `要把「${cardSelected.title}」重新恢復到要做的卡片池嗎？`,
          async () => {
            try {
              await restoreCard(cardSelected, appState.currentUser, appState.currentUserDoc);
              appState.selectedCardId = null;
              showToast("卡片已恢復");
            } catch (err) {
              showToast("操作被拒絕：" + err.message);
            }
          }
        );
      }, "manage"]);
    }

    // 4. 返回按鈕
    actions.push(["返回", "↩", () => {
      appState.selectedCardId = null;
      renderCards();
    }, ""]);

    // 填充空白導覽按鈕，維護 5 欄均分
    while (actions.length < 5) {
      actions.unshift(["", "", () => {}, "disabled"]);
    }

    actions.forEach(([txt, icon, fn, clName]) => {
      const b = document.createElement("button");
      b.className = `navBtn ${clName}`;
      if (clName === "disabled") b.disabled = true;
      b.innerHTML = `<b>${icon}</b><span>${txt}</span>`;
      b.onclick = fn;
      dom.bottomNav.appendChild(b);
    });

  } else {
    // ----------------------------------------------------
    // 行動 B：未選取卡片 (全域頁籤分流導覽)
    // ----------------------------------------------------
    const tabs = [
      ["全部", "📋", "all", ""],
      ["我建立", "✍️", "mine", ""],
      ["已結束", "✅", "ended", ""],
      ["紀錄", "📜", "logs", ""],
      ["說明", "ℹ️", "more", ""]
    ];

    tabs.forEach(([txt, icon, tabId, clName]) => {
      const b = document.createElement("button");
      const isActive = appState.currentTab === tabId;
      b.className = `navBtn ${isActive ? "on" : ""} ${clName}`;
      b.innerHTML = `<b>${icon}</b><span>${txt}</span>`;
      
      b.onclick = () => {
        if (tabId === "more") {
          showToast(appState.currentUserDoc?.role === "manage" ? "管理身分：可收起所有卡片並執行恢復。" : "協作身分：可建立卡片與完成自己建立的卡片。");
          return;
        }
        
        // 切換頁籤
        appState.currentTab = tabId;
        appState.selectedCardId = null; // 切換分頁時自動清除卡片選取

        if (tabId === "logs") {
          dom.cards.innerHTML = "";
          dom.records.hidden = false;
          renderLogs();
        } else {
          dom.records.hidden = true;
          // 重建對應分頁的即時訂閱 (由 app.js 管理)
          window.dispatchEvent(new CustomEvent("tab-changed", { detail: tabId }));
        }
      };

      dom.bottomNav.appendChild(b);
    });
  }
}

// ==========================================
// 4. 輔助轉換常式
// ==========================================

function escapeHTML(str) {
  if (!str) return "";
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function formatTime(timestamp) {
  if (!timestamp) return "讀取中...";
  // 處理 Firebase serverTimestamp 的兩種包裝可能
  const date = timestamp.seconds ? new Date(timestamp.seconds * 1000) : new Date(timestamp);
  
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hr = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  
  return `${m}/${d} ${hr}:${min}`;
}
