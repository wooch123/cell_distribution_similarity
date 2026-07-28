const DATABASE_NAME = "vth-shape-learning";
const DATABASE_VERSION = 1;
const STORE_NAME = "samples";

function requireIndexedDb() {
  if (!globalThis.indexedDB) {
    throw new Error("이 브라우저는 로컬 학습 저장소를 지원하지 않습니다.");
  }
  return globalThis.indexedDB;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = requireIndexedDb().open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "id",
        });
        store.createIndex("learnedAt", "learnedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("로컬 학습 저장소를 열지 못했습니다."));
  });
}

function runTransaction(mode, operation) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let result;
        try {
          result = operation(store);
        } catch (error) {
          database.close();
          reject(error);
          return;
        }
        transaction.oncomplete = () => {
          database.close();
          resolve(result);
        };
        transaction.onerror = () => {
          database.close();
          reject(
            transaction.error ??
              new Error("로컬 학습 저장소 작업을 완료하지 못했습니다."),
          );
        };
      }),
  );
}

export function listLocalTrainingSamples() {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => {
          database.close();
          resolve(
            request.result.sort((left, right) =>
              String(right.learnedAt).localeCompare(String(left.learnedAt)),
            ),
          );
        };
        request.onerror = () => {
          database.close();
          reject(
            request.error ??
              new Error("로컬 학습 후보를 불러오지 못했습니다."),
          );
        };
      }),
  );
}

export function saveLocalTrainingSample(record) {
  return runTransaction("readwrite", (store) => store.put(record));
}

export function deleteLocalTrainingSample(id) {
  return runTransaction("readwrite", (store) => store.delete(id));
}

export function clearLocalTrainingSamples() {
  return runTransaction("readwrite", (store) => store.clear());
}

export async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("이미지를 변환하지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}
