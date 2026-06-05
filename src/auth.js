// - 核心理由：Email 白名單認證核心。利用 Google 提供的 Email 檢索白名單，並於首次登入時在伺服器端完成 One-Time UID 綁定。
// - 權責邊界：[負責] 判定 Email 是否在白名單、初次綁定用戶 UID。 [不負責] 建立全新 Email 節點。
// - MWE：配合 index.html 與 Email 規則，對不在白名單內的 Google 帳號進行阻斷。
// - 致命錯誤邊界：綁定後，若 UID 與 Auth 帳號不符，直接阻斷強制登出，防止冒名劫持，風險受控。

import { auth, db, googleProvider } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/**
 * 啟動 Google Popup 授權登入
 */
export async function login() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error("Auth: Google login failed", err);
    throw err;
  }
}

/**
 * 安全登出
 */
export async function logout() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Auth: Logout failed", err);
    throw err;
  }
}

/**
 * 監聽認證狀態變更 (Email 白名單安全綁定與檢查)
 * @param {Function} onUserUpdate 狀態回呼函式 (firebaseUser, userFirestoreDoc, errorMessage) => {}
 */
export function listenAuth(onUserUpdate) {
  return onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      onUserUpdate(null, null);
      return;
    }

    const email = firebaseUser.email;
    if (!email) {
      console.error("Auth: Google User email is missing!");
      await logout();
      onUserUpdate(null, null, "登入失敗：未能取得您的 Google 電子郵件。");
      return;
    }

    // 以 Email 作為 Firestore 文件 ID 進行檢索
    const userRef = doc(db, "users", email);
    
    try {
      let userSnap = await getDoc(userRef);

      // 1. 檢查是否在使用者清單內；若不存在，建立待審核帳號後拒絕本次進入
      if (!userSnap.exists()) {
        console.log(`Auth: First-time applicant. Creating pending user document for ${email}.`);
        await setDoc(userRef, {
          email: email,
          displayName: firebaseUser.displayName || "協作者",
          role: "user",
          active: false,
          uid: "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          requestSource: "google_login"
        });
        await logout();
        onUserUpdate(null, null, "已建立使用申請，請等待管理者啟用帳號。");
        return;
      }

      let userData = userSnap.data();

      // 2. 檢查帳號是否被停用
      if (userData.active !== true) {
        console.warn(`Auth: Denied. Email ${email} is deactivated.`);
        await logout();
        onUserUpdate(null, null, "帳號尚未啟用，請等待管理者啟用。");
        return;
      }

      // 3. 首次登入自動綁定 UID
      if (!userData.uid || userData.uid === "") {
        console.log(`Auth: First-time login. Binding UID for ${email}`);
        
        // 綁定當前用戶的 UID 與 姓名
        await updateDoc(userRef, {
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName || userData.displayName || "協作者",
          updatedAt: serverTimestamp()
        });

        // 重新讀取，確保更新反映至本機狀態
        userSnap = await getDoc(userRef);
        userData = userSnap.data();
      }

      // 4. 防禦性檢查：驗證綁定的 UID 是否與目前登入的 UID 一致，防止 Email 冒用
      if (userData.uid !== firebaseUser.uid) {
        console.error(`Auth: Security breach! UID mismatch for ${email}. Expect: ${userData.uid}, Got: ${firebaseUser.uid}`);
        await logout();
        onUserUpdate(null, null, "安全性錯誤：帳號 UID 綁定不符，請聯絡管理員。");
        return;
      }

      // 5. 認證通過，更新 UI
      onUserUpdate(firebaseUser, userData);

    } catch (err) {
      console.error("Auth: Sync user document failed", err);
      await logout();
      onUserUpdate(null, null, "系統驗證失敗，請重新嘗試。");
    }
  });
}
