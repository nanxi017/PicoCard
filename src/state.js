// - 核心理由：集中化管理客戶端 runtime 狀態，並提供防禦性的 BDD 狀態機權限判定纯粹函式（Pure Functions）。
// - 權責邊界：[負責] 保存當前登入者、選中卡片、當前頁籤等全域狀態；計算各種卡片與留言變更操作的合法性。 [不負責] 寫入資料庫與變更 DOM。
// - MWE：此檔案為自包含純粹 JavaScript 程式，不需任何外部依賴，即可直接執行單元測試驗證邏輯。
// - 致命錯誤邊界：避免使用容易造成狀態不一致的雙向綁定；全部採用單一來源狀態（Single Source of Truth），風險受控。

export const appState = {
  currentUser: null,       // Firebase Auth 原始 User 實體
  currentUserDoc: null,    // Firestore /users/{uid} 的文檔資料 (role, active 等)
  currentTab: "all",       // 當前分頁頁籤："all" (全部) | "mine" (我建立) | "ended" (結束) | "logs" (紀錄)
  selectedCardId: null,    // 當前點選選中的卡片 ID
  cards: [],               // 當前訂閱的卡片快照清單
  logs: []                 // 當前訂閱的歷史日誌快照清單
};

// ==========================================
// 1. 商業邏輯與 BDD 契約判定 (Pure Functions)
// ==========================================

/**
 * 判定卡片是否已結束 (無論是標記完成 completed 或是被收起 putaway)
 * @param {Object} card 卡片物件
 * @returns {boolean}
 */
export function isEnded(card) {
  if (!card) return false;
  return card.state === "done" || card.life === "putaway";
}

/**
 * 判定當前使用者是否可「完成」此卡片 (BDD 契約: 卡片必須未結束，且必須是卡片建立者本人)
 * 備註：管理員亦無法替代他人點選完成。
 * @param {Object} card 卡片物件
 * @param {Object} user Firebase Auth 實體
 * @param {Object} userData Firestore 使用者文檔
 * @returns {boolean}
 */
export function canComplete(card, user, userData) {
  if (!card || !user || !userData) return false;
  return card.life === "open" 
    && card.state === "open" 
    && card.createdBy === user.uid;
}

/**
 * 判定當前使用者是否可「收起」此卡片 (BDD 契約: 卡片必須未結束，且必須是建立者本人或具備管理權限者)
 * @param {Object} card 卡片物件
 * @param {Object} user Firebase Auth 實體
 * @param {Object} userData Firestore 使用者文檔
 * @returns {boolean}
 */
export function canPutaway(card, user, userData) {
  if (!card || !user || !userData) return false;
  return card.life === "open" 
    && card.state === "open" 
    && (card.createdBy === user.uid || userData.role === "manage");
}

/**
 * 判定當前使用者是否可「恢復」此卡片 (BDD 契約: 卡片必須已被收起，且必須是具備管理權限者)
 * @param {Object} card 卡片物件
 * @param {Object} user Firebase Auth 實體
 * @param {Object} userData Firestore 使用者文檔
 * @returns {boolean}
 */
export function canRestore(card, user, userData) {
  if (!card || !user || !userData) return false;
  return card.life === "putaway" 
    && userData.role === "manage";
}

/**
 * 判定當前留言是否可被收回 (BDD 契約: 留言生命週期為 open 且建立者必須是自己)
 * @param {Object} note 留言物件
 * @param {Object} user Firebase Auth 實體
 * @returns {boolean}
 */
export function canRecallNote(note, user) {
  if (!note || !user) return false;
  return note.life === "open" 
    && note.createdBy === user.uid;
}

// ==========================================
// 2. 狀態管理突變與取值子 (State Mutators & Getters)
// ==========================================

export function setCurrentUser(user, userDoc) {
  appState.currentUser = user;
  appState.currentUserDoc = userDoc;
}

export function setCurrentTab(tab) {
  appState.currentTab = tab;
}

export function setSelectedCardId(id) {
  appState.selectedCardId = id;
}

export function getSelectedCard() {
  if (!appState.selectedCardId) return null;
  return appState.cards.find(c => c.id === appState.selectedCardId) || null;
}

export function setCards(cardsList) {
  appState.cards = cardsList;
}

export function setLogs(logsList) {
  appState.logs = logsList;
}
