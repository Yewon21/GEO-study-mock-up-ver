# 지리 암기 노트

Vite + React 앱. Vercel에 그대로 배포된다.

## 폴더 구조

```
geo-memo/
├── index.html            시작점 (폰트, 뷰포트 설정)
├── package.json          의존성 (react, react-dom, lucide-react)
├── vite.config.js
└── src/
    ├── main.jsx          React 마운트
    ├── GeoMemoApp.jsx    앱 본체
    └── storage.js        저장소 (IndexedDB)
```

## 로컬에서 실행

```bash
npm install
npm run dev
```

## Vercel 배포

1. 이 폴더를 GitHub 저장소에 올린다 (`node_modules`는 빼고 — `.gitignore`가 처리해 준다).
2. vercel.com → **Add New → Project** → 그 저장소를 고른다.
3. 설정은 건드릴 필요 없다. Vercel이 Vite를 알아서 인식한다.
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Deploy.

이미 `geo-study-mock-up-ver` 프로젝트가 있다면, Settings → Git에서 이 저장소로 연결만 바꾸면 같은 주소를 계속 쓸 수 있다.

---

## 데이터 저장에 대해

### 어디에 저장되나

**IndexedDB**에 저장된다. 브라우저 안에 있는 작은 데이터베이스라서 용량이 수백 MB 이상이다. 사진이 들어간 카드를 많이 만들어도 괜찮다.

이전에 쓰던 `localStorage`는 용량이 약 5MB뿐이라, 사진 몇십 장이면 꽉 차서 **저장이 조용히 실패했다.** 그래서 바꿨다.

기존에 localStorage에 저장돼 있던 데이터가 있으면 앱을 처음 열 때 IndexedDB로 자동으로 옮겨진다. 원본도 그대로 남겨두니까 사라질 걱정은 안 해도 된다.

### 그래도 조심할 것

브라우저 저장소라서 이런 경우엔 데이터가 없어진다:

- 브라우저 설정에서 "인터넷 사용 기록 삭제" 할 때 **쿠키 및 사이트 데이터** 항목을 같이 지우는 경우
- 시크릿/프라이빗 모드에서 쓴 경우 (창 닫으면 사라짐)
- 다른 기기·다른 브라우저에서 열면 데이터가 안 보인다 (기기마다 따로 저장됨)

앱이 브라우저에게 "이 데이터는 함부로 지우지 말아 달라"고 요청하도록 해 뒀지만(`requestPersistence`), 브라우저가 항상 들어주는 건 아니다.

### 그래서 백업을 꼭 하자

앱에 이미 **JSON 내보내기 / 가져오기** 기능이 있다. 시험 전이나 카드를 많이 추가한 날엔 내보내기를 눌러서 파일을 저장해 두면 된다. 새 기기로 옮길 때도 이 파일로 가져오면 그대로 복원된다.

**Claude 아티팩트에서 쓰던 데이터는 Vercel 사이트로 자동으로 넘어오지 않는다.** 아티팩트에서 JSON 내보내기 → Vercel 사이트에서 가져오기, 이 순서로 옮겨야 한다.

### 저장 상태 확인하는 법

브라우저 개발자 도구 콘솔에서:

```js
await geoStorageInfo()
```

현재 어떤 저장소를 쓰는지(`idb` / `ls` / `host`), 키가 몇 개 저장돼 있는지, 남은 용량이 얼마인지 나온다.

---

## 여러 기기에서 같이 쓰고 싶다면

지금 구조는 기기마다 데이터가 따로 논다. 폰이랑 노트북에서 같은 카드를 보려면 서버가 필요하다. Supabase 무료 플랜 정도면 충분한데, 로그인 기능까지 붙여야 해서 작업량이 꽤 는다. 지금은 JSON 내보내기로 옮기는 게 현실적이다.
