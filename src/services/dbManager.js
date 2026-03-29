import initSqlJs from 'sql.js';

let SQL = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method TEXT NOT NULL,
  date TEXT NOT NULL,
  budget_category TEXT NOT NULL,
  sub_category TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  discount_amount INTEGER DEFAULT 0,
  discount_note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sub_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_category TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(budget_category, name)
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trip_countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);
`;

const DEFAULT_PAYMENT_METHODS = [
  '신한카드', '현대카드', '삼성카드', '롯데카드',
  '현금',
];

const DEFAULT_CATEGORIES = {
  '식비':       ['아침', '점심', '저녁', '간식/카페', '야식', '장보기'],
  '차량교통비': ['주유', '세차', '주차비', '대중교통', '택시', '고속도로', '정비/수리', '대리운전'],
  '쇼핑':       ['생필품', '가전', '가구', '온라인쇼핑', '상품권', '중고거래'],
  '공과금':     ['관리비', '전기', '가스', '수도', '대형폐기물', '재산세(주택)', '자동차세', '서류', '주민세'],
  '정기결제':   ['OTT/스트리밍', '통신', '쇼핑멤버십', '차량구독', '연회비', '소프트웨어', '보험'],
  '취미/놀이': ['로또', '동행복권', '이모티콘', '노래방', '운동', '영화', '웹툰', '게임', '독서', '관람'],
  '의류/미용':  ['의류', '신발', '미용실', '화장품', '악세서리', '세탁소'],
  '의료비':     ['병원', '약국', '헬스/운동', '실손보험', '정부지원'],
  '반려동물':   ['사료/간식', '병원', '용품'],
  '여행':       ['숙박', '항공/교통', '아침', '점심', '저녁', '야식', '간식/카페', '쇼핑', '문화생활', '입장료', '환전', '여행상품', '짐보관', '정산'],
  '경조사비':   ['축의금', '부의금', '선물', '기부', '결혼식'],
  '모임/약속':  ['모임', '데이트', '회사'],
  '가족지원':   ['용돈'],
  '아버지':     ['아버지', '아버지 쇼핑'],
  '주거/수리':  ['주택', '가전', '이사', '중개수수료'],
  '기타지출':   ['합의금', '벌금/과태료', '보상금'],
};

export async function initSQL() {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: file => `https://unpkg.com/sql.js@1.12.0/dist/${file}`,
    });
  }
  return SQL;
}

export function createDatabase(SQL, existingData = null) {
  const db = existingData ? new SQL.Database(existingData) : new SQL.Database();
  db.run(SCHEMA);

  // is_hidden 컬럼 마이그레이션 (있으면 무시)
  ['payment_methods', 'budget_categories', 'sub_categories'].forEach(table => {
    try {
      db.run(`ALTER TABLE ${table} ADD COLUMN is_hidden INTEGER DEFAULT 0`);
    } catch (e) {
      // 이미 존재하면 무시
    }
  });

  // color 컬럼 마이그레이션 (있으면 무시)
  try {
    db.run(`ALTER TABLE budget_categories ADD COLUMN color TEXT DEFAULT ''`);
  } catch (e) {
    // 이미 존재하면 무시
  }

  // 카테고리 이름 변경 마이그레이션
  const categoryRenames = [
    ['의료/건강', '의료비'],
    ['여행/문화', '여행'],
    ['수리비', '주거/수리'],
  ];
  categoryRenames.forEach(([oldName, newName]) => {
    const exists = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', [oldName]);
    if ((exists[0]?.values[0][0] || 0) > 0) {
      const newExists = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', [newName]);
      if ((newExists[0]?.values[0][0] || 0) === 0) {
        db.run('UPDATE budget_categories SET name = ? WHERE name = ?', [newName, oldName]);
        db.run('UPDATE transactions SET budget_category = ? WHERE budget_category = ?', [newName, oldName]);
        db.run('UPDATE sub_categories SET budget_category = ? WHERE budget_category = ?', [newName, oldName]);
      }
    }
  });

  // 카테고리 통합 마이그레이션 (여러 메인 → 하나의 메인 + 서브로 이관)
  const categoryMerges = [
    { to: '경조사비', from: ['축의금', '부의금', '선물', '기부'] },
    { to: '모임/약속', from: ['모임', '데이트', '회사'] },
    { to: '가족지원', from: ['용돈'] },
  ];
  categoryMerges.forEach(({ to, from }) => {
    const hasOld = from.some(cat => {
      const r = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', [cat]);
      return (r[0]?.values[0][0] || 0) > 0;
    });
    if (!hasOld) return;
    const newExists = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', [to]);
    if ((newExists[0]?.values[0][0] || 0) === 0) {
      const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM budget_categories');
      db.run('INSERT INTO budget_categories (name, sort_order, is_hidden) VALUES (?, ?, 0)', [to, (maxSort[0]?.values[0][0] || 0) + 1]);
      from.forEach((sub, i) => {
        db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', [to, sub, i + 1]);
      });
    }
    from.forEach(oldCat => {
      const oldExists = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', [oldCat]);
      if ((oldExists[0]?.values[0][0] || 0) > 0) {
        db.run('UPDATE transactions SET budget_category = ?, sub_category = ? WHERE budget_category = ?', [to, oldCat, oldCat]);
        db.run('DELETE FROM sub_categories WHERE budget_category = ?', [oldCat]);
        db.run('DELETE FROM budget_categories WHERE name = ?', [oldCat]);
      }
    });
  });

  // 서브카테고리 이름 변경 마이그레이션
  const subCategoryRenames = [
    { budgetCategory: '식비',       oldName: '카페',      newName: '간식/카페' },
    { budgetCategory: '식비',       oldName: '간식',      newName: '간식/카페' },
    { budgetCategory: '공과금',     oldName: '수도세',    newName: '수도' },
    { budgetCategory: '의류/미용', oldName: '세탁비',     newName: '세탁소' },
    { budgetCategory: '취미/놀이', oldName: '영화표',     newName: '영화' },
    { budgetCategory: '취미/놀이', oldName: '네이버웹툰', newName: '웹툰' },
    { budgetCategory: '차량교통비', oldName: '택시비',    newName: '택시' },
    { budgetCategory: '차량교통비', oldName: '하이패스',  newName: '고속도로' },
    { budgetCategory: '공과금',     oldName: '가스비',    newName: '가스' },
    { budgetCategory: '공과금',     oldName: '전기세',    newName: '전기' },
    { budgetCategory: '차량교통비', oldName: '주유비',    newName: '주유' },
    { budgetCategory: '차량교통비', oldName: '세차비',    newName: '세차' },
    { budgetCategory: '차량교통비', oldName: '차량정비',  newName: '정비/수리' },
  ];
  subCategoryRenames.forEach(({ budgetCategory, oldName, newName }) => {
    // 마스터 테이블 정리: oldName 항목 제거 (newName이 이미 있거나 없거나 모두)
    db.run(
      'DELETE FROM sub_categories WHERE budget_category = ? AND name = ?',
      [budgetCategory, oldName]
    );
    // 트랜잭션 데이터 업데이트
    db.run(
      'UPDATE transactions SET sub_category = ? WHERE budget_category = ? AND sub_category = ?',
      [newName, budgetCategory, oldName]
    );
  });

  // 정기결제: 기존 서브카테고리명 → (새 서브카테고리 + 상세내역) 마이그레이션
  const 정기결제Migrations = [
    { oldSub: '쿠팡',               newSub: '쇼핑멤버십',    detail: '쿠팡' },
    { oldSub: '기아 UVO',           newSub: '차량구독',      detail: '기아 UVO' },
    { oldSub: '통신비(KT)',         newSub: '통신',          detail: 'KT' },
    { oldSub: '통신비(KT 알뜰폰)', newSub: '통신',          detail: '알뜰폰' },
    { oldSub: 'YouTube',            newSub: 'OTT/스트리밍',  detail: 'YouTube' },
  ];
  정기결제Migrations.forEach(({ oldSub, newSub, detail }) => {
    db.run(
      `UPDATE transactions
       SET sub_category = ?,
           detail = CASE WHEN (detail = '' OR detail IS NULL) THEN ? ELSE detail END
       WHERE budget_category = '정기결제' AND sub_category = ?`,
      [newSub, detail, oldSub]
    );
    db.run(
      'DELETE FROM sub_categories WHERE budget_category = ? AND name = ?',
      ['정기결제', oldSub]
    );
  });

  // 서브카테고리 → (새 서브카테고리 + 상세내역) 마이그레이션
  const subToDetailMigrations = [
    { budgetCategory: '식비',  oldSub: '노브랜드', newSub: '장보기',    detail: '노브랜드' },
    { budgetCategory: '식비',  oldSub: '이마트',   newSub: '장보기',    detail: '이마트' },
    { budgetCategory: '쇼핑',  oldSub: '다이소',   newSub: '생필품',    detail: '다이소' },
    { budgetCategory: '식비',  oldSub: '스타벅스', newSub: '간식/카페', detail: '스타벅스' },
    { budgetCategory: '식비',  oldSub: '편의점',   newSub: '장보기',    detail: '편의점' },
    { budgetCategory: '쇼핑',  oldSub: '올리브영', newSub: '생필품',    detail: '올리브영' },
    { budgetCategory: '쇼핑',  oldSub: '네이버페이', newSub: '상품권',  detail: '네이버페이' },
  ];
  subToDetailMigrations.forEach(({ budgetCategory, oldSub, newSub, detail }) => {
    db.run(
      `UPDATE transactions
       SET sub_category = ?,
           detail = CASE WHEN (detail = '' OR detail IS NULL) THEN ? ELSE detail END
       WHERE budget_category = ? AND sub_category = ?`,
      [newSub, detail, budgetCategory, oldSub]
    );
    db.run(
      'DELETE FROM sub_categories WHERE budget_category = ? AND name = ?',
      [budgetCategory, oldSub]
    );
  });

  // 서브카테고리 추가 마이그레이션 (detail 키워드 기반, sub_category가 비어 있는 경우)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['식비', '장보기', 99]);
  const detailSubMappings = [
    { budgetCategory: '쇼핑', keyword: '다이소',   newSub: '생필품' },
    { budgetCategory: '식비', keyword: '노브랜드', newSub: '장보기' },
    { budgetCategory: '식비', keyword: '이마트',   newSub: '장보기' },
    { budgetCategory: '식비', keyword: '스타벅스', newSub: '간식/카페' },
  ];
  detailSubMappings.forEach(({ budgetCategory, keyword, newSub }) => {
    db.run(
      `UPDATE transactions SET sub_category = ?
       WHERE budget_category = ? AND detail LIKE ?
         AND (sub_category = '' OR sub_category IS NULL)`,
      [newSub, budgetCategory, `%${keyword}%`]
    );
  });

  // 아버지 서브카테고리 추가 (없는 것만)
  ['아버지', '아버지 쇼핑'].forEach((sub, i) => {
    db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['아버지', sub, i + 1]);
  });

  // 수리비 카테고리 추가 (없는 것만)
  if ((db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', ['수리비'])[0]?.values[0][0] || 0) === 0) {
    const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM budget_categories');
    db.run('INSERT INTO budget_categories (name, sort_order, is_hidden) VALUES (?, ?, 0)', ['수리비', (maxSort[0]?.values[0][0] || 0) + 1]);
  }
  ['주택', '가전'].forEach((sub, i) => {
    db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['수리비', sub, i + 1]);
  });

  // 공과금 서브카테고리 추가 (없는 것만)
  ['관리비', '전기', '가스', '수도', '대형폐기물', '재산세(주택)', '자동차세', '서류', '주민세'].forEach((sub, i) => {
    db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['공과금', sub, i + 1]);
  });

  // 쇼핑 서브카테고리 추가 (없는 것만)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['쇼핑', '상품권', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['쇼핑', '중고거래', 99]);
  // 쇼핑 - 연회비 => 정기결제 - 연회비
  db.run(
    `UPDATE transactions SET budget_category = '정기결제'
     WHERE budget_category = '쇼핑' AND sub_category = '연회비'`
  );
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['쇼핑', '연회비']);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['정기결제', '연회비', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['정기결제', '소프트웨어', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['정기결제', '보험', 99]);

  // 주거/수리 서브카테고리 추가 (없는 것만)
  ['이사', '중개수수료'].forEach((sub) => {
    db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['주거/수리', sub, 99]);
  });

  // 쇼핑 - 의류 제거
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['쇼핑', '의류']);
  // 쇼핑 - 아버지 쇼핑 => 아버지 - 아버지 쇼핑
  db.run(
    `UPDATE transactions SET budget_category = '아버지', sub_category = '아버지 쇼핑'
     WHERE budget_category = '쇼핑' AND sub_category = '아버지 쇼핑'`
  );
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['쇼핑', '아버지 쇼핑']);
  // 모임 - 모임 / 모임정산 => 모임/약속 - 모임
  db.run(
    `UPDATE transactions SET budget_category = '모임/약속', sub_category = '모임'
     WHERE budget_category = '모임' AND sub_category IN ('모임', '모임정산')`
  );
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['모임', '모임정산']);
  // 쇼핑 - 네이버맴버십 => 정기결제 - 쇼핑멤버십 - 네이버맴버십
  db.run(
    `UPDATE transactions
     SET budget_category = '정기결제', sub_category = '쇼핑멤버십',
         detail = CASE WHEN (detail = '' OR detail IS NULL) THEN '네이버맴버십' ELSE detail END
     WHERE budget_category = '쇼핑' AND sub_category = '네이버맴버십'`
  );
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['쇼핑', '네이버맴버십']);
  // 쇼핑 - 토스프라임 => 정기결제 - 쇼핑멤버십 - 토스프라임
  db.run(
    `UPDATE transactions
     SET budget_category = '정기결제', sub_category = '쇼핑멤버십',
         detail = CASE WHEN (detail = '' OR detail IS NULL) THEN '토스프라임' ELSE detail END
     WHERE budget_category = '쇼핑' AND sub_category = '토스프라임'`
  );
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['쇼핑', '토스프라임']);

  // 여행 서브카테고리 추가 (없는 것만)
  ['아침', '점심', '저녁', '야식', '간식/카페', '환전', '여행상품', '짐보관', '정산'].forEach((sub) => {
    db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['여행', sub, 99]);
  });
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['여행', '식비']);
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', ['여행', '투어']);

  // 의류/미용 서브카테고리 추가 (없는 것만)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['의류/미용', '신발', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['의류/미용', '세탁소', 99]);

  // 경조사비 서브카테고리 추가 (없는 것만)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['경조사비', '결혼식', 99]);

  // 의료비 서브카테고리 추가 (없는 것만)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['의료비', '실손보험', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['의료비', '정부지원', 99]);

  // 취미/놀이 서브카테고리 추가 (없는 것만)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '이모티콘', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '노래방', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '운동', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '영화', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '웹툰', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '게임', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '독서', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['취미/놀이', '관람', 99]);
  // 취미/놀이 - 네이버페이 - 네이버웹툰 => 취미/놀이 - 웹툰
  db.run(
    `UPDATE transactions SET sub_category = '웹툰', detail = ''
     WHERE budget_category = '취미/놀이' AND sub_category = '네이버페이' AND detail = '네이버웹툰'`
  );

  // 차량교통비 서브카테고리 추가 (없는 것만)
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['차량교통비', '정비/수리', 99]);
  db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['차량교통비', '대리운전', 99]);

  // 정기결제 서브카테고리 추가 및 기존 데이터 마이그레이션
  let didMigrate = false;
  ['OTT/스트리밍', '통신', '쇼핑멤버십', '차량구독'].forEach((sub, i) => {
    db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['정기결제', sub, i + 1]);
  });
  const subMappings = [
    { keywords: ['YouTube', '유튜브', 'Netflix', '넷플릭스', 'Disney', '왓챠', 'Wavve', '웨이브', 'Tving', '티빙', 'Spotify', '스포티파이', 'Apple TV'], sub: 'OTT/스트리밍' },
    { keywords: ['통신', 'KT', '알뜰폰', 'SKT', 'LG U+', 'LGU+'], sub: '통신' },
    { keywords: ['쿠팡', '네이버플러스'], sub: '쇼핑멤버십' },
    { keywords: ['UVO', 'BlueLink', '블루링크', 'Connect'], sub: '차량구독' },
  ];
  subMappings.forEach(({ keywords, sub }) => {
    keywords.forEach(keyword => {
      db.run(
        `UPDATE transactions SET sub_category = ? WHERE budget_category = '정기결제' AND (sub_category = '' OR sub_category IS NULL) AND detail LIKE ?`,
        [sub, `%${keyword}%`]
      );
      if (db.getRowsModified() > 0) didMigrate = true;
    });
  });

  // 불필요한 카테고리 삭제
  ['기타'].forEach(cat => {
    db.run('DELETE FROM sub_categories WHERE budget_category = ?', [cat]);
    db.run('DELETE FROM budget_categories WHERE name = ?', [cat]);
  });

  // 새 카테고리 추가 마이그레이션 (기존 DB에 없는 것만)
  const newCategories = Object.entries(DEFAULT_CATEGORIES);
  newCategories.forEach(([cat, subs], catIdx) => {
    const catExists = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ?', [cat]);
    if ((catExists[0]?.values[0][0] || 0) === 0) {
      const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM budget_categories');
      const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
      db.run('INSERT INTO budget_categories (name, sort_order, is_hidden) VALUES (?, ?, 0)', [cat, nextSort]);
      subs.forEach((sub, subIdx) => {
        db.run(
          'INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)',
          [cat, sub, subIdx + 1]
        );
      });
    }
  });

  // discount_rate 컬럼 마이그레이션 (있으면 무시)
  try {
    db.run(`ALTER TABLE payment_methods ADD COLUMN discount_rate REAL DEFAULT 0`);
  } catch (e) {
    // 이미 존재하면 무시
  }

  // 여행 관련 컬럼 마이그레이션 (있으면 무시)
  try {
    db.run(`ALTER TABLE transactions ADD COLUMN trip_id INTEGER DEFAULT NULL`);
  } catch (e) {}
  try {
    db.run(`ALTER TABLE transactions ADD COLUMN foreign_amounts TEXT DEFAULT ''`);
  } catch (e) {}

  // 사용하지 않는 결제수단 영구 삭제 마이그레이션
  ['KB국민카드', '카카오페이', '네이버페이', '토스페이'].forEach(name => {
    const used = db.exec('SELECT COUNT(*) FROM transactions WHERE payment_method = ?', [name]);
    if ((used[0]?.values[0][0] || 0) === 0) {
      db.run('DELETE FROM payment_methods WHERE name = ?', [name]);
    }
  });

  // 기본 데이터는 테이블이 비어있을 때만 삽입
  const pmCount = db.exec('SELECT COUNT(*) FROM payment_methods')[0]?.values[0][0] || 0;
  if (pmCount === 0) {
    DEFAULT_PAYMENT_METHODS.forEach((name, i) => {
      db.run('INSERT OR IGNORE INTO payment_methods (name, sort_order) VALUES (?, ?)', [name, i + 1]);
    });
    Object.entries(DEFAULT_CATEGORIES).forEach(([cat, subs], catIdx) => {
      db.run('INSERT OR IGNORE INTO budget_categories (name, sort_order) VALUES (?, ?)', [cat, catIdx + 1]);
      subs.forEach((sub, subIdx) => {
        db.run(
          'INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)',
          [cat, sub, subIdx + 1]
        );
      });
    });
  }

  return { db, didMigrate };
}

export function exportDatabase(db) {
  return db.export();
}

// ── 거래 내역 ─────────────────────────────────────────────────

export function getTransactions(db, filters = {}) {
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (filters.month) {
    query += " AND strftime('%Y-%m', date) = ?";
    params.push(filters.month);
  }
  if (filters.payment_method) {
    query += ' AND payment_method = ?';
    params.push(filters.payment_method);
  }
  if (filters.budget_category) {
    query += ' AND budget_category = ?';
    params.push(filters.budget_category);
  }
  if (filters.dateFrom) {
    query += ' AND date >= ?';
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    query += ' AND date <= ?';
    params.push(filters.dateTo);
  }
  if (filters.search) {
    query += ' AND (detail LIKE ? OR sub_category LIKE ? OR discount_note LIKE ?)';
    const kw = `%${filters.search}%`;
    params.push(kw, kw, kw);
  }

  query += ' ORDER BY date DESC, id DESC';

  const result = db.exec(query, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addTransaction(db, tx) {
  db.run(
    `INSERT INTO transactions
       (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, trip_id, foreign_amounts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.trip_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
    ]
  );
}

export function updateTransaction(db, id, tx) {
  db.run(
    `UPDATE transactions
     SET payment_method=?, date=?, budget_category=?, sub_category=?,
         detail=?, amount=?, discount_amount=?, discount_note=?,
         trip_id=?, foreign_amounts=?,
         updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.trip_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
      id,
    ]
  );
}

export function deleteTransaction(db, id) {
  db.run('DELETE FROM transactions WHERE id = ?', [id]);
}

// ── 마스터 데이터 ──────────────────────────────────────────────

export function getPaymentMethods(db) {
  const result = db.exec('SELECT name FROM payment_methods WHERE is_hidden = 0 ORDER BY sort_order, name');
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getBudgetCategories(db) {
  const result = db.exec('SELECT name FROM budget_categories WHERE is_hidden = 0 ORDER BY sort_order, name');
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getSubCategories(db, budgetCategory) {
  if (!budgetCategory) return [];
  const result = db.exec(
    'SELECT name FROM sub_categories WHERE budget_category = ? AND is_hidden = 0 ORDER BY sort_order, name',
    [budgetCategory]
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

// ── 요약 ───────────────────────────────────────────────────────

export function getAvailableMonths(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y-%m', date) as month FROM transactions ORDER BY month DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getMonthlySummary(db, month) {
  const query = month
    ? `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions WHERE strftime('%Y-%m', date) = ?
       GROUP BY budget_category ORDER BY total DESC`
    : `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions GROUP BY budget_category ORDER BY total DESC`;

  const result = db.exec(query, month ? [month] : []);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getMonthlyTotals(db, limit = 24) {
  const query = limit
    ? `SELECT strftime('%Y-%m', date) as month,
              SUM(amount) as total,
              SUM(discount_amount) as discount,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month ORDER BY month DESC
       LIMIT ${limit}`
    : `SELECT strftime('%Y-%m', date) as month,
              SUM(amount) as total,
              SUM(discount_amount) as discount,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month ORDER BY month DESC`;
  const result = db.exec(query);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getPaymentMethodSummary(db, month) {
  const query = month
    ? `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions WHERE strftime('%Y-%m', date) = ?
       GROUP BY payment_method ORDER BY total DESC`
    : `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions GROUP BY payment_method ORDER BY total DESC`;

  const result = db.exec(query, month ? [month] : []);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAvailableYears(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y', date) as year FROM transactions ORDER BY year DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getYearlySummary(db, year) {
  const query = `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE strftime('%Y', date) = ?
                 GROUP BY budget_category ORDER BY total DESC`;
  const result = db.exec(query, [year]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getYearlyPaymentMethodSummary(db, year) {
  const query = `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE strftime('%Y', date) = ?
                 GROUP BY payment_method ORDER BY total DESC`;
  const result = db.exec(query, [year]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getRangeSummary(db, dateFrom, dateTo) {
  const query = `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE date >= ? AND date <= ?
                 GROUP BY budget_category ORDER BY total DESC`;
  const result = db.exec(query, [dateFrom, dateTo]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getRangePaymentMethodSummary(db, dateFrom, dateTo) {
  const query = `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE date >= ? AND date <= ?
                 GROUP BY payment_method ORDER BY total DESC`;
  const result = db.exec(query, [dateFrom, dateTo]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getTripSummary(db) {
  const query = `
    SELECT tr.id as trip_id, tr.name as trip_name,
           t.amount, t.discount_amount, t.foreign_amounts
    FROM transactions t
    JOIN trips tr ON t.trip_id = tr.id
    WHERE t.trip_id IS NOT NULL
    ORDER BY tr.sort_order, tr.id
  `;

  const result = db.exec(query);
  if (!result.length) return [];
  const { columns, values } = result[0];

  const tripMap = {};
  const tripOrder = [];
  values.forEach(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });

    const key = obj.trip_id;
    if (!tripMap[key]) {
      tripMap[key] = { trip_id: obj.trip_id, trip_name: obj.trip_name, total: 0, discount: 0, cnt: 0, foreignTotals: {} };
      tripOrder.push(key);
    }
    const trip = tripMap[key];
    trip.total += obj.amount || 0;
    trip.discount += obj.discount_amount || 0;
    trip.cnt += 1;

    if (obj.foreign_amounts) {
      try {
        const fa = JSON.parse(obj.foreign_amounts);
        Object.entries(fa).forEach(([currency, amount]) => {
          trip.foreignTotals[currency] = (trip.foreignTotals[currency] || 0) + Number(amount);
        });
      } catch (e) {}
    }
  });

  return tripOrder.map(k => tripMap[k]).sort((a, b) => b.total - a.total);
}

export function getTripDetailSummary(db, tripId) {
  const result = db.exec(
    'SELECT sub_category, amount, discount_amount, foreign_amounts FROM transactions WHERE trip_id = ?',
    [tripId]
  );
  if (!result.length) return [];
  const { columns, values } = result[0];

  const subMap = {};
  const subOrder = [];
  values.forEach(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    const key = obj.sub_category || '(미분류)';
    if (!subMap[key]) {
      subMap[key] = { sub_category: key, total: 0, discount: 0, cnt: 0, foreignTotals: {} };
      subOrder.push(key);
    }
    const sub = subMap[key];
    sub.total += obj.amount || 0;
    sub.discount += obj.discount_amount || 0;
    sub.cnt += 1;
    if (obj.foreign_amounts) {
      try {
        const fa = JSON.parse(obj.foreign_amounts);
        Object.entries(fa).forEach(([currency, amount]) => {
          sub.foreignTotals[currency] = (sub.foreignTotals[currency] || 0) + Number(amount);
        });
      } catch (e) {}
    }
  });
  return subOrder.map(k => subMap[k]).sort((a, b) => b.total - a.total);
}

export function getTripPaymentMethodSummary(db, tripId = null) {
  const where = tripId ? 'trip_id = ?' : 'trip_id IS NOT NULL';
  const params = tripId ? [tripId] : [];
  const query = `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE ${where}
                 GROUP BY payment_method ORDER BY total DESC`;
  const result = db.exec(query, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// ── 마스터 데이터 편집 (설정용) ──────────────────────────

export function getAllPaymentMethods(db) {
  const result = db.exec('SELECT id, name, sort_order, is_hidden, discount_rate FROM payment_methods ORDER BY sort_order, name');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllBudgetCategories(db) {
  const result = db.exec('SELECT id, name, sort_order, is_hidden, color FROM budget_categories ORDER BY sort_order, name');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllSubCategories(db, budgetCategory = null) {
  if (budgetCategory) {
    const result = db.exec(
      'SELECT id, budget_category, name, sort_order, is_hidden FROM sub_categories WHERE budget_category = ? ORDER BY sort_order, name',
      [budgetCategory]
    );
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  } else {
    const result = db.exec('SELECT id, budget_category, name, sort_order, is_hidden FROM sub_categories ORDER BY budget_category, sort_order, name');
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }
}

export function reorderMasterItem(db, table, id, direction) {
  const allowed = ['payment_methods', 'budget_categories', 'sub_categories'];
  if (!allowed.includes(table)) throw new Error('Invalid table name');

  // 현재 아이템의 sort_order (sub_categories는 budget_category도 필요)
  let currRes;
  if (table === 'sub_categories') {
    currRes = db.exec('SELECT sort_order, budget_category FROM sub_categories WHERE id = ?', [id]);
  } else {
    currRes = db.exec(`SELECT sort_order FROM ${table} WHERE id = ?`, [id]);
  }
  if (!currRes.length || !currRes[0].values.length) return;

  const currentOrder = currRes[0].values[0][0];
  const budgetCat = table === 'sub_categories' ? currRes[0].values[0][1] : null;

  // 인접 아이템 찾기
  let neighborRes;
  if (table === 'sub_categories') {
    neighborRes = direction === 'up'
      ? db.exec('SELECT id, sort_order FROM sub_categories WHERE sort_order < ? AND budget_category = ? ORDER BY sort_order DESC LIMIT 1', [currentOrder, budgetCat])
      : db.exec('SELECT id, sort_order FROM sub_categories WHERE sort_order > ? AND budget_category = ? ORDER BY sort_order ASC LIMIT 1', [currentOrder, budgetCat]);
  } else {
    neighborRes = direction === 'up'
      ? db.exec(`SELECT id, sort_order FROM ${table} WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1`, [currentOrder])
      : db.exec(`SELECT id, sort_order FROM ${table} WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1`, [currentOrder]);
  }
  if (!neighborRes.length || !neighborRes[0].values.length) return;

  const [neighborId, neighborOrder] = neighborRes[0].values[0];
  db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [neighborOrder, id]);
  db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [currentOrder, neighborId]);
}

export function setMasterItemHidden(db, table, id, isHidden) {
  const allowed = ['payment_methods', 'budget_categories', 'sub_categories'];
  if (!allowed.includes(table)) throw new Error('Invalid table name');
  db.run(`UPDATE ${table} SET is_hidden = ? WHERE id = ?`, [isHidden ? 1 : 0, id]);
}

export function addPaymentMethod(db, name) {
  if (!name || !name.trim()) throw new Error('Name is required');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM payment_methods');
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO payment_methods (name, sort_order, is_hidden) VALUES (?, ?, 0)', [name.trim(), nextSort]);
}

export function addBudgetCategory(db, name) {
  if (!name || !name.trim()) throw new Error('Name is required');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM budget_categories');
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO budget_categories (name, sort_order, is_hidden) VALUES (?, ?, 0)', [name.trim(), nextSort]);
}

export function addSubCategory(db, budgetCategory, name) {
  if (!budgetCategory || !name || !name.trim()) throw new Error('Both category and name are required');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM sub_categories WHERE budget_category = ?', [budgetCategory]);
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO sub_categories (budget_category, name, sort_order, is_hidden) VALUES (?, ?, ?, 0)', [budgetCategory, name.trim(), nextSort]);
}

export function ensurePaymentMethodsExist(db, txList) {
  // 트랜잭션 목록에서 사용된 결제수단들을 자동으로 추가
  const paymentMethods = new Set(txList.map(tx => tx.payment_method).filter(Boolean));
  const existingResult = db.exec('SELECT name FROM payment_methods');
  const existingMethods = new Set(existingResult[0]?.values.map(r => r[0]) || []);

  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM payment_methods');
  let nextSort = (maxSort[0]?.values[0][0] || 0) + 1;

  paymentMethods.forEach(method => {
    if (!existingMethods.has(method)) {
      db.run('INSERT INTO payment_methods (name, sort_order, is_hidden) VALUES (?, ?, 0)', [method, nextSort]);
      nextSort++;
    }
  });
}

export function bulkInsertTransactions(db, txList) {
  db.run('BEGIN');
  try {
    ensurePaymentMethodsExist(db, txList);
    txList.forEach(tx => addTransaction(db, tx));
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

export function cleanupHiddenPaymentMethods(db) {
  // 숨겨진 결제수단 중 데이터에서 사용되지 않는 것들 삭제
  const result = db.exec(
    `SELECT id, name FROM payment_methods WHERE is_hidden = 1`
  );
  if (!result.length) return;

  result[0].values.forEach(row => {
    const [id, name] = row;
    const usageResult = db.exec(
      'SELECT COUNT(*) FROM transactions WHERE payment_method = ?',
      [name]
    );
    const count = usageResult[0]?.values[0][0] || 0;
    if (count === 0) {
      db.run('DELETE FROM payment_methods WHERE id = ?', [id]);
    }
  });
}

export function setCategoryColor(db, categoryId, color) {
  db.run('UPDATE budget_categories SET color = ? WHERE id = ?', [color, categoryId]);
}

export function getCategoryColor(db, categoryName) {
  const result = db.exec('SELECT color FROM budget_categories WHERE name = ?', [categoryName]);
  if (!result.length) return '';
  return result[0].values[0][0] || '';
}

export function getPaymentMethodDiscountRates(db) {
  const result = db.exec('SELECT name, discount_rate FROM payment_methods');
  if (!result.length) return {};
  const rates = {};
  result[0].values.forEach(([name, rate]) => { rates[name] = rate || 0; });
  return rates;
}

export function setPaymentMethodDiscountRate(db, name, rate) {
  db.run('UPDATE payment_methods SET discount_rate = ? WHERE name = ?', [rate, name]);
}

export function bulkApplyWooriDiscount(db) {
  let count = 0;
  // 2026-02 이하: 30%
  const r1 = db.exec(
    "SELECT id, amount FROM transactions WHERE payment_method = '우리카드' AND strftime('%Y-%m', date) <= '2026-02'"
  );
  if (r1.length) {
    r1[0].values.forEach(([id, amount]) => {
      db.run('UPDATE transactions SET discount_amount = ? WHERE id = ?', [Math.round(amount * 0.3), id]);
      count++;
    });
  }
  // 2026-03 이상: 20%
  const r2 = db.exec(
    "SELECT id, amount FROM transactions WHERE payment_method = '우리카드' AND strftime('%Y-%m', date) >= '2026-03'"
  );
  if (r2.length) {
    r2[0].values.forEach(([id, amount]) => {
      db.run('UPDATE transactions SET discount_amount = ? WHERE id = ?', [Math.round(amount * 0.2), id]);
      count++;
    });
  }
  // 앞으로 새 거래에도 적용되도록 기본 할인율 20%로 설정
  db.run("UPDATE payment_methods SET discount_rate = 0.2 WHERE name = '우리카드'");
  return count;
}

export function bulkApplyShinhanDiscount(db) {
  const result = db.exec(
    "SELECT id, amount FROM transactions WHERE payment_method = '신한카드' AND amount >= 5000"
  );
  if (!result.length) return 0;
  let count = 0;
  result[0].values.forEach(([id, amount]) => {
    const discount = amount % 1000;
    if (discount > 0) {
      db.run('UPDATE transactions SET discount_amount = ? WHERE id = ?', [discount, id]);
      count++;
    }
  });
  return count;
}

// ── 여행 ──────────────────────────────────────────────────────────

export function getTrips(db) {
  const res = db.exec('SELECT id, name FROM trips WHERE is_hidden = 0 ORDER BY sort_order, id');
  if (!res.length) return [];
  return res[0].values.map(([id, name]) => ({
    id, name,
    countries: getTripCountries(db, id),
  }));
}

export function getTripCountries(db, tripId) {
  const res = db.exec(
    'SELECT id, country, currency FROM trip_countries WHERE trip_id = ? ORDER BY sort_order, id',
    [tripId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, country, currency]) => ({ id, country, currency }));
}

export function getAllTrips(db) {
  const res = db.exec('SELECT id, name, sort_order, is_hidden FROM trips ORDER BY sort_order, id');
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addTrip(db, name) {
  if (!name || !name.trim()) throw new Error('여행 이름을 입력하세요');
  const minSort = db.exec('SELECT COALESCE(MIN(sort_order), 1) FROM trips');
  const nextSort = (minSort[0]?.values[0][0] || 1) - 1;
  db.run('INSERT INTO trips (name, sort_order, is_hidden) VALUES (?, ?, 0)', [name.trim(), nextSort]);
}

export function updateTripName(db, id, name) {
  if (!name || !name.trim()) throw new Error('여행 이름을 입력하세요');
  db.run('UPDATE trips SET name = ? WHERE id = ?', [name.trim(), id]);
}

export function deleteTrip(db, id) {
  const res = db.exec('SELECT COUNT(*) FROM transactions WHERE trip_id = ?', [id]);
  const count = res[0]?.values[0][0] || 0;
  db.run('UPDATE transactions SET trip_id = NULL WHERE trip_id = ?', [id]);
  db.run('DELETE FROM trip_countries WHERE trip_id = ?', [id]);
  db.run('DELETE FROM trips WHERE id = ?', [id]);
  return count;
}

export function reorderTrip(db, id, direction) {
  const currRes = db.exec('SELECT sort_order FROM trips WHERE id = ?', [id]);
  if (!currRes.length || !currRes[0].values.length) return;
  const currentOrder = currRes[0].values[0][0];
  const neighborRes = direction === 'up'
    ? db.exec('SELECT id, sort_order FROM trips WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1', [currentOrder])
    : db.exec('SELECT id, sort_order FROM trips WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1', [currentOrder]);
  if (!neighborRes.length || !neighborRes[0].values.length) return;
  const [neighborId, neighborOrder] = neighborRes[0].values[0];
  db.run('UPDATE trips SET sort_order = ? WHERE id = ?', [neighborOrder, id]);
  db.run('UPDATE trips SET sort_order = ? WHERE id = ?', [currentOrder, neighborId]);
}

export function addTripCountry(db, tripId, country, currency) {
  if (!country || !country.trim()) throw new Error('나라명을 입력하세요');
  if (!currency || !currency.trim()) throw new Error('화폐 단위를 입력하세요');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM trip_countries WHERE trip_id = ?', [tripId]);
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run(
    'INSERT INTO trip_countries (trip_id, country, currency, sort_order) VALUES (?, ?, ?, ?)',
    [tripId, country.trim(), currency.trim().toUpperCase(), nextSort]
  );
}

export function deleteTripCountry(db, id) {
  db.run('DELETE FROM trip_countries WHERE id = ?', [id]);
}
