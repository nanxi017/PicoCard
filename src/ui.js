// - 核心理由：系統唯一的畫面渲染與互動管理器，使用靜態單一 PWA Shell，僅負責畫面渲染與互動；UI 採弱視友善大型字級與觸控級距，第 3 欄「新增」直接喚起新增面板。
// - 權責邊界：[負責] 操控 DOM、處理中鍵點擊直接調用 openSheet()、彈出原子確認盒、提示 Toast、管理留言監聽釋放。 [不負責] 直接呼叫資料庫 API。
// - MWE：在 index.html 載入後，配合 DOM 元素進行介面渲染。
// - 致命錯誤邊界：卡片重繪時必須嚴格釋放舊留言的即時監聽（onSnapshot），否則累積的 Listener 將導致瀏覽器記憶體洩漏當機，此處使用 noteUnsubscribers 完全規避，風險受控。

import { appState, isEnded, canComplete, canPutaway, canRestore, canRecallNote, getSelectedCard } from "./state.js";
import { login, logout } from "./auth.js";
import { createCard, completeCard, putawayCard, restoreCard, updateCardBody, createNote, recallNote, subscribeNotes } from "./firestore.js";

// ==========================================
// 1. DOM 節點快取
// ==========================================
export const dom = {
  loginScreen: document.getElementById("loginScreen"),
  mainApp: document.getElementById("mainApp"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  userBadge: document.getElementById("userBadge"),
  infoBtn: document.getElementById("infoBtn"), // 💡 方案 A 整合說明按鈕
  stats: document.getElementById("stats"),
  listTitle: document.getElementById("listTitle"),
  count: document.getElementById("count"),
  cards: document.getElementById("cards"),
  records: document.getElementById("records"),
  empty: document.getElementById("empty"),
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

// ==========================================
// 1.1 單一 PWA Shell：靜態骨架由 index.html/CSS 負責
// ==========================================
let topDockReady = false;

function ensureFinalTopDockLayout() {
  if (topDockReady) return;
  topDockReady = true;
  document.title = "一起辦｜卡片協作工具";
}

function runCardAction(action, card) {
  if (action === "complete") {
    askConfirm(
      "確認完成",
      `要把「${card.title}」標記為完成嗎？`,
      async () => {
        try {
          await completeCard(card, appState.currentUser, appState.currentUserDoc);
          appState.selectedCardId = null;
          showToast("卡片已完成");
        } catch (err) {
          showToast("操作被拒絕：" + err.message);
        }
      }
    );
  }
  if (action === "putaway") {
    askConfirm(
      "確認收起",
      `要把「${card.title}」放入收起夾嗎？`,
      async () => {
        try {
          await putawayCard(card, appState.currentUser, appState.currentUserDoc);
          appState.selectedCardId = null;
          showToast("卡片已收起");
        } catch (err) {
          showToast("操作被拒絕：" + err.message);
        }
      },
      true
    );
  }
  if (action === "restore") {
    askConfirm(
      "確認恢復",
      `要把「${card.title}」重新恢復到要做的卡片池嗎？`,
      async () => {
        try {
          await restoreCard(card, appState.currentUser, appState.currentUserDoc);
          appState.selectedCardId = null;
          showToast("卡片已恢復");
        } catch (err) {
          showToast("操作被拒絕：" + err.message);
        }
      }
    );
  }
  if (action === "editBody") {
    const nextBody = window.prompt("訂正卡片內容（最多 500 字）：", card.body || "");
    if (nextBody === null) return;
    const normalizedBody = nextBody.trim();
    if (normalizedBody.length > 500) {
      showToast("內容最多 500 字");
      return;
    }
    askConfirm(
      "確認訂正內容",
      `要更新「${card.title}」的卡片內容嗎？`,
      async () => {
        try {
          await updateCardBody(card, normalizedBody, appState.currentUser, appState.currentUserDoc);
          showToast("卡片內容已訂正");
        } catch (err) {
          showToast("訂正失敗：" + err.message);
        }
      }
    );
  }
}

function buildCardActionDetails(card) {
  const actions = [];
  if (canComplete(card, appState.currentUser, appState.currentUserDoc)) {
    actions.push(["完成", "complete", ""]);
  }
  if (canPutaway(card, appState.currentUser, appState.currentUserDoc)) {
    actions.push(["收起", "putaway", "danger"]);
  }
  if (canRestore(card, appState.currentUser, appState.currentUserDoc)) {
    actions.push(["恢復", "restore", "manage"]);
  }
  if (card.createdBy === appState.currentUser?.uid && card.life === "open") {
    actions.push(["編輯內容", "editBody", ""]);
  }
  if (actions.length === 0) return null;

  const details = document.createElement("details");
  details.className = "cardActionDetails";
  const summary = document.createElement("summary");
  summary.textContent = "操作";
  details.appendChild(summary);

  const row = document.createElement("div");
  row.className = "cardActionRow";
  actions.forEach(([label, action, cls]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = label;
    btn.onclick = (e) => {
      e.stopPropagation();
      details.open = false;
      runCardAction(action, card);
    };
    row.appendChild(btn);
  });
  details.appendChild(row);
  return details;
}


// 用以儲存各個卡片留言監聽器的登出回呼，防止記憶體洩漏
const noteUnsubscribers = new Map();

// 展開/收起內文的狀態快取 (CardId -> boolean)
const expandedBodies = new Set();

// 展開/收合留言的狀態快取 (CardId -> boolean)
const expandedNotes = new Set();

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
  ensureFinalTopDockLayout();
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
  // 統計摘要不固定，且永遠使用全域 appState.cards。
  // 禁止用頁籤篩選後的 renderList 計算，避免「已結束」頁污染待處理與我建立數字。
  const source = appState.cards;
  const uid = appState.currentUser?.uid;
  const totalActive = source.filter(c => c.state === "open" && c.life === "open").length;
  const totalMine = source.filter(c => c.state === "open" && c.life === "open" && c.createdBy === uid).length;
  const totalDone = source.filter(c => c.state === "done" && c.life === "open").length;
  const totalPutaway = source.filter(c => c.life === "putaway").length;

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
  // 卡片頁負責卡片容器；避免「紀錄」頁殘留污染卡片分頁
  dom.records.hidden = true;
  dom.records.textContent = "";

  // 先釋放舊留言監聽
  releaseNoteListeners();
  dom.cards.innerHTML = "";

  // 依據頁籤過濾卡片；統計摘要仍使用全域 appState.cards。
  let renderList = [...appState.cards];
  if (appState.currentTab === "mine") {
    renderList = renderList.filter(c => c.state === "open" && c.life === "open" && c.createdBy === appState.currentUser?.uid);
  } else if (appState.currentTab === "ended") {
    renderList = renderList.filter(c => c.ended === true || c.state === "done" || c.life === "putaway");
  } else {
    renderList = renderList.filter(c => c.state === "open" && c.life === "open");
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
    
    // 卡片本身只負責閱讀；卡片操作由小型「操作」入口處理。
    cardEl.onclick = (e) => {
      if (e.target.closest("button") || e.target.closest("form") || e.target.closest("input") || e.target.closest("details")) {
        return;
      }
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
    metaRow.textContent = `建立：${card.createdByName} ｜ 建立時間：${formatTime(card.createdAt)}`;
    cardEl.appendChild(metaRow);

    const lastModifiedRow = document.createElement("div");
    lastModifiedRow.className = "meta lastModified";
    lastModifiedRow.textContent = `最後修改：${formatTime(card.bodyUpdatedAt || card.createdAt)}`;
    cardEl.appendChild(lastModifiedRow);

    const cardActions = buildCardActionDetails(card);
    if (cardActions) {
      cardEl.appendChild(cardActions);
    }

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

      const activeNotes = notesList.filter(n => n.life === "open");
      const notesExpanded = expandedNotes.has(card.id);
      const displayNotes = activeNotes.length <= 2 || notesExpanded
        ? activeNotes
        : activeNotes.slice(-2);

      if (activeNotes.length > 2) {
        const noteToggle = document.createElement("button");
        noteToggle.type = "button";
        noteToggle.className = "textBtn notesToggle";
        noteToggle.textContent = notesExpanded ? "收合留言" : `查看全部 ${activeNotes.length} 則留言`;
        noteToggle.onclick = (e) => {
          e.stopPropagation();
          if (notesExpanded) {
            expandedNotes.delete(card.id);
          } else {
            expandedNotes.add(card.id);
          }
          renderCards();
        };
        notesContainer.appendChild(noteToggle);
      }

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
  // 紀錄頁負責紀錄容器；避免前一個卡片分頁的空狀態、選取狀態與留言監聽殘留
  releaseNoteListeners();
  appState.selectedCardId = null;
  dom.empty.classList.remove("show");

  dom.listTitle.textContent = "系統操作紀錄";
  dom.count.textContent = appState.logs.length >= 30 ? "最新 30 筆" : `${appState.logs.length} 筆`;
  dom.count.textContent = appState.logs.length >= 30 ? "最新 30 筆" : `${appState.logs.length} 筆`;
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
  ensureFinalTopDockLayout();
  dom.bottomNav.innerHTML = "";

  const tabs = [
    ["全部", "📋", "all", ""],
    ["我建立", "✍️", "mine", ""],
    ["新增", "➕", "add_sheet", "add-primary"],
    ["已結束", "✔", "ended", ""],
    ["紀錄", "📝", "logs", ""]
  ];

  tabs.forEach(([txt, icon, tabId, clName]) => {
    const b = document.createElement("button");
    const isActive = appState.currentTab === tabId;
    b.className = `navBtn ${isActive ? "on" : ""} ${clName}`;
    b.innerHTML = `<b>${icon}</b><span>${txt}</span>`;

    b.onclick = () => {
      if (tabId === "add_sheet") {
        openSheet();
        return;
      }

      appState.currentTab = tabId;
      appState.selectedCardId = null;
      if (tabId === "logs") {
        dom.cards.innerHTML = "";
        dom.records.textContent = "載入系統操作紀錄中...";
        dom.records.hidden = false;
        dom.empty.classList.remove("show");
      } else {
        dom.records.hidden = true;
        dom.records.textContent = "";
      }
      window.dispatchEvent(new CustomEvent("tab-changed", { detail: tabId }));
    };

    dom.bottomNav.appendChild(b);
  });
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
