// - 核心理由：系統資料儲存與流轉控制器，利用 WriteBatch 封裝多文件寫入，保證卡片狀態、衍生欄位 ended、留言與 Log 的原子一致性。
// - 權責邊界：[負責] 實作 Firestore CRUD、即時數據監聽、Log 寫入與留言收回。 [不負責] UI 視窗呈現與事件監聽。
// - MWE：配合 auth 登入後，呼叫對應寫入與訂閱方法。
// - 致命錯誤邊界：若卡片更新狀態而 Log 寫入失敗，會造成資料碎片與查核困難；本模組所有突變均強制使用寫入交易，並完全保障 ended 轉換對齊規則，風險受控。

import { db } from "./firebase.js";
import {
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ==========================================
// 1. 數據訂閱 (即時監聽)
// ==========================================

/**
 * 監聽卡片集合
 * @param {string} filter 篩選器："all" (全部未結束) | "mine" (我建立的未結束) | "ended" (已結束)
 * @param {string} userId 目前登入的使用者 uid
 * @param {Function} callback 數據更新時的回呼函式 (cards) => {}
 */
export function subscribeCards(filter, userId, callback) {
  const cardsRef = collection(db, "cards");

  // 統計與全域摘要必須永遠基於完整 cards 集合。
  // 頁籤分類只應在 UI 的 renderCards() 內做可視列表篩選。
  const q = query(
    cardsRef,
    orderBy("updatedAt", "desc")
  );

  return onSnapshot(q, (snapshot) => {
    const cards = [];
    snapshot.forEach((docSnap) => {
      cards.push({ id: docSnap.id, ...docSnap.data() });
    });
    callback(cards);
  }, (err) => {
    console.error(`Firestore: Subscribe cards failed (filter: ${filter})`, err);
  });
}

/**
 * 監聽指定卡片的所有留言 (包括已收回，由前端 ui 決定顯示內容)
 */
export function subscribeNotes(cardId, callback) {
  const notesRef = collection(db, "cards", cardId, "notes");
  const q = query(notesRef, orderBy("createdAt", "asc"));

  return onSnapshot(q, (snapshot) => {
    const notes = [];
    snapshot.forEach((docSnap) => {
      notes.push({ id: docSnap.id, ...docSnap.data() });
    });
    callback(notes);
  }, (err) => {
    console.error(`Firestore: Subscribe notes failed (cardId: ${cardId})`, err);
  });
}

/**
 * 監聽全域活動紀錄 (上限 100 筆)
 */
export function subscribeLogs(callback) {
  const logsRef = collection(db, "activityLogs");
  const q = query(logsRef, orderBy("createdAt", "desc"), limit(30));

  return onSnapshot(q, (snapshot) => {
    const logs = [];
    snapshot.forEach((docSnap) => {
      logs.push({ id: docSnap.id, ...docSnap.data() });
    });
    callback(logs);
  }, (err) => {
    console.error("Firestore: Subscribe logs failed", err);
  });
}

// ==========================================
// 2. 寫入與原子交易突變
// ==========================================

/**
 * 新增卡片 (與新增 Log 綁定交易)
 */
export async function createCard(title, body, user, userData) {
  const batch = writeBatch(db);
  const cardColRef = collection(db, "cards");
  const cardDocRef = doc(cardColRef); // 自動生成 ID
  const logColRef = collection(db, "activityLogs");
  const logDocRef = doc(logColRef);

  const timestamp = serverTimestamp();

  const newCard = {
    title: title,
    body: body,
    state: "open",
    life: "open",
    ended: false, // 衍生欄位，對應 open/open 為 false
    createdBy: user.uid,
    createdByName: userData.displayName || user.displayName || "協作者",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    completedBy: null,
    putawayAt: null,
    putawayBy: null,
    restoredAt: null,
    restoredBy: null,
    reason: ""
  };

  const newLog = {
    cardId: cardDocRef.id,
    actorId: user.uid,
    actorName: userData.displayName || user.displayName || "協作者",
    action: "card_created",
    text: `新增了卡片「${title}」`,
    createdAt: timestamp
  };

  batch.set(cardDocRef, newCard);
  batch.set(logDocRef, newLog);

  await batch.commit();
}

/**
 * 標記完成卡片 (建立者限定，與 Log 綁定交易)
 */
export async function completeCard(card, user, userData) {
  const batch = writeBatch(db);
  const cardDocRef = doc(db, "cards", card.id);
  const logColRef = collection(db, "activityLogs");
  const logDocRef = doc(logColRef);

  const timestamp = serverTimestamp();

  batch.update(cardDocRef, {
    state: "done",
    ended: true, // 狀態變更 done -> ended 強制為 true
    completedBy: user.uid,
    completedAt: timestamp,
    updatedAt: timestamp
  });

  batch.set(logDocRef, {
    cardId: card.id,
    actorId: user.uid,
    actorName: userData.displayName || user.displayName || "協作者",
    action: "card_completed",
    text: `完成了卡片「${card.title}」`,
    createdAt: timestamp
  });

  await batch.commit();
}

/**
 * 收起卡片 (建立者或管理，與 Log 綁定交易)
 */
export async function putawayCard(card, user, userData) {
  const batch = writeBatch(db);
  const cardDocRef = doc(db, "cards", card.id);
  const logColRef = collection(db, "activityLogs");
  const logDocRef = doc(logColRef);

  const timestamp = serverTimestamp();
  const reasonText = userData.role === "manage" ? "管理收起" : "建立者收起";

  batch.update(cardDocRef, {
    life: "putaway",
    ended: true, // 狀態變更 putaway -> ended 強制為 true
    putawayBy: user.uid,
    putawayAt: timestamp,
    updatedAt: timestamp,
    reason: reasonText
  });

  batch.set(logDocRef, {
    cardId: card.id,
    actorId: user.uid,
    actorName: userData.displayName || user.displayName || "協作者",
    action: "card_putaway",
    text: `收起了卡片「${card.title}」(${reasonText})`,
    createdAt: timestamp
  });

  await batch.commit();
}

/**
 * 恢復卡片 (管理限定，與 Log 綁定交易)
 */
export async function restoreCard(card, user, userData) {
  const batch = writeBatch(db);
  const cardDocRef = doc(db, "cards", card.id);
  const logColRef = collection(db, "activityLogs");
  const logDocRef = doc(logColRef);

  const timestamp = serverTimestamp();

  batch.update(cardDocRef, {
    state: "open",
    life: "open",
    ended: false, // 狀態變更 open/open -> ended 強制為 false
    restoredBy: user.uid,
    restoredAt: timestamp,
    updatedAt: timestamp,
    reason: ""
  });

  batch.set(logDocRef, {
    cardId: card.id,
    actorId: user.uid,
    actorName: userData.displayName || user.displayName || "協作者",
    action: "card_restored",
    text: `恢復了已收起卡片「${card.title}」`,
    createdAt: timestamp
  });

  await batch.commit();
}

/**
 * 對卡片新增留言
 */
export async function createNote(cardId, cardTitle, text, user, userData) {
  const batch = writeBatch(db);
  const cardDocRef = doc(db, "cards", cardId);
  const noteColRef = collection(db, "cards", cardId, "notes");
  const noteDocRef = doc(noteColRef);
  const logColRef = collection(db, "activityLogs");
  const logDocRef = doc(logColRef);

  const timestamp = serverTimestamp();
  const name = userData.displayName || user.displayName || "協作者";

  // 1. 建立留言
  batch.set(noteDocRef, {
    text: text,
    createdBy: user.uid,
    createdByName: name,
    life: "open",
    createdAt: timestamp,
    updatedAt: timestamp
  });

  // 2. 強制更新卡片更新時間 (以觸發即時排序)
  batch.update(cardDocRef, {
    updatedAt: timestamp
  });

  // 3. 寫入留言日誌
  batch.set(logDocRef, {
    cardId: cardId,
    actorId: user.uid,
    actorName: name,
    action: "note_created",
    text: `在卡片「${cardTitle}」留下發言：「${text}」`,
    createdAt: timestamp
  });

  await batch.commit();
}

/**
 * 安全收回留言 (100% 對齊修補版安全規則：不硬刪除，而是將 life 設為 recalled 並清空內容)
 */
export async function recallNote(cardId, cardTitle, noteId, user, userData) {
  const batch = writeBatch(db);
  const cardDocRef = doc(db, "cards", cardId);
  const noteDocRef = doc(db, "cards", cardId, "notes", noteId);
  const logColRef = collection(db, "activityLogs");
  const logDocRef = doc(logColRef);

  const timestamp = serverTimestamp();
  const name = userData.displayName || user.displayName || "協作者";

  // 1. 更新留言生命週期為 recalled，且文字強制設為空字串 (安全規則嚴格查核)
  batch.update(noteDocRef, {
    life: "recalled",
    text: "",
    updatedAt: timestamp
  });

  // 2. 強制更新卡片更新時間
  batch.update(cardDocRef, {
    updatedAt: timestamp
  });

  // 3. 寫入留言收回日誌
  batch.set(logDocRef, {
    cardId: cardId,
    actorId: user.uid,
    actorName: name,
    action: "note_recalled",
    text: `收回了卡片「${cardTitle}」的一則發言`,
    createdAt: timestamp
  });

  await batch.commit();
}
