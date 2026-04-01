/**
 * @deprecated
 * 일단락된 DB 마이그레이션 코드 보관 파일.
 * 현재 실행되지 않으며, 참고 목적으로만 보존.
 * 재적용이 필요한 경우 runLegacyMigrations(db) 를 createDatabase() 내에서 호출할 것.
 */

// 설정-데이터 초기값 — UI를 통해 직접 정의 가능하므로 더 이상 사용하지 않음
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
  '취미/놀이':  ['로또', '동행복권', '이모티콘', '노래방', '운동', '영화', '웹툰', '게임', '독서', '관람'],
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

/**
 * @deprecated 일단락된 마이그레이션. 현재 호출되지 않음.
 * @param {import('sql.js').Database} db
 * @returns {boolean} didMigrate
 */
export function runLegacyMigrations(db) {
  let didMigrate = false;

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
    db.run(
      'DELETE FROM sub_categories WHERE budget_category = ? AND name = ?',
      [budgetCategory, oldName]
    );
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

  // 아버지 서브카테고리 추가 (서브카테고리가 전혀 없을 때만 기본값 삽입)
  const 아버지SubCount = db.exec('SELECT COUNT(*) FROM sub_categories WHERE budget_category = ?', ['아버지']);
  if ((아버지SubCount[0]?.values[0][0] || 0) === 0) {
    ['아버지', '아버지 쇼핑'].forEach((sub, i) => {
      db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', ['아버지', sub, i + 1]);
    });
  }

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
  Object.entries(DEFAULT_CATEGORIES).forEach(([cat, subs]) => {
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

  // payment_method_discount_rules 테이블 마이그레이션 (기존 DB 대응)
  try {
    db.run(`CREATE TABLE IF NOT EXISTS payment_method_discount_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_method_name TEXT NOT NULL,
      budget_category TEXT DEFAULT '',
      sub_category TEXT DEFAULT '',
      detail_keyword TEXT DEFAULT '',
      rule_type TEXT NOT NULL DEFAULT 'percent',
      value REAL NOT NULL DEFAULT 0,
      min_amount INTEGER DEFAULT 0,
      note TEXT DEFAULT ''
    )`);
  } catch (e) {}
  // detail_keyword 컬럼 마이그레이션 (이미 테이블이 있는 기존 DB 대응)
  try {
    db.run(`ALTER TABLE payment_method_discount_rules ADD COLUMN detail_keyword TEXT DEFAULT ''`);
  } catch (e) {}

  // 신한카드: hardcoded 규칙 → DB 규칙 마이그레이션
  {
    const cnt = db.exec("SELECT COUNT(*) FROM payment_method_discount_rules WHERE payment_method_name = '신한카드'")[0]?.values[0][0] || 0;
    const ex = db.exec("SELECT COUNT(*) FROM payment_methods WHERE name = '신한카드'")[0]?.values[0][0] || 0;
    if (cnt === 0 && ex > 0) {
      db.run("INSERT INTO payment_method_discount_rules (payment_method_name, rule_type, value, min_amount, note) VALUES ('신한카드', 'remainder', 1000, 5000, '5천원 이상 구매 시 천원 미만 잔액 포인트')");
    }
  }

  // 하나카드: hardcoded 규칙 → DB 규칙 마이그레이션
  {
    const cnt = db.exec("SELECT COUNT(*) FROM payment_method_discount_rules WHERE payment_method_name = '하나카드'")[0]?.values[0][0] || 0;
    const ex = db.exec("SELECT COUNT(*) FROM payment_methods WHERE name = '하나카드'")[0]?.values[0][0] || 0;
    if (cnt === 0 && ex > 0) {
      const rateRes = db.exec("SELECT discount_rate FROM payment_methods WHERE name = '하나카드'");
      const rate = rateRes[0]?.values[0][0] || 0.01;
      db.run("INSERT INTO payment_method_discount_rules (payment_method_name, rule_type, value, min_amount, note) VALUES ('하나카드', 'percent', ?, 0, '기본 적립')", [rate || 0.01]);
      db.run("INSERT INTO payment_method_discount_rules (payment_method_name, budget_category, sub_category, rule_type, value, min_amount, note) VALUES ('하나카드', '차량교통비', '주유', 'percent', 0.012, 0, '주유 1.2% 적립')");
      db.run("INSERT INTO payment_method_discount_rules (payment_method_name, budget_category, sub_category, rule_type, value, min_amount, note) VALUES ('하나카드', '차량교통비', '세차', 'percent', 0.012, 0, '세차 1.2% 적립')");
      db.run("INSERT INTO payment_method_discount_rules (payment_method_name, detail_keyword, rule_type, value, min_amount, note) VALUES ('하나카드', '스타벅스', 'percent', 0.5, 0, '스타벅스 50% 할인')");
    }
  }
  // 하나카드 스타벅스 규칙: detail_keyword 컬럼 추가 후 기존 규칙이 있는 경우 보완
  {
    const ex = db.exec("SELECT COUNT(*) FROM payment_methods WHERE name = '하나카드'")[0]?.values[0][0] || 0;
    if (ex > 0) {
      const sbCnt = db.exec("SELECT COUNT(*) FROM payment_method_discount_rules WHERE payment_method_name = '하나카드' AND detail_keyword = '스타벅스'")[0]?.values[0][0] || 0;
      if (sbCnt === 0) {
        db.run("INSERT INTO payment_method_discount_rules (payment_method_name, detail_keyword, rule_type, value, min_amount, note) VALUES ('하나카드', '스타벅스', 'percent', 0.5, 0, '스타벅스 50% 할인')");
      }
    }
  }

  // 기타 카드: discount_rate → 기본 percent 규칙 마이그레이션
  {
    const pmRes = db.exec("SELECT name, discount_rate FROM payment_methods WHERE discount_rate > 0 AND name NOT IN ('신한카드', '하나카드')");
    if (pmRes.length) {
      pmRes[0].values.forEach(([name, rate]) => {
        const cnt = db.exec("SELECT COUNT(*) FROM payment_method_discount_rules WHERE payment_method_name = ?", [name])[0]?.values[0][0] || 0;
        if (cnt === 0) {
          const pct = Math.round(rate * 1000) / 10;
          db.run("INSERT INTO payment_method_discount_rules (payment_method_name, rule_type, value, note) VALUES (?, 'percent', ?, ?)", [name, rate, `기본 ${pct}% 적립`]);
        }
      });
    }
  }

  // 사용하지 않는 결제수단 영구 삭제 마이그레이션
  ['KB국민카드', '카카오페이', '네이버페이', '토스페이'].forEach(name => {
    const used = db.exec('SELECT COUNT(*) FROM transactions WHERE payment_method = ?', [name]);
    if ((used[0]?.values[0][0] || 0) === 0) {
      db.run('DELETE FROM payment_methods WHERE name = ?', [name]);
    }
  });

  // 설정-데이터 기본값 삽입 — UI를 통해 직접 정의 가능하므로 더 이상 사용하지 않음
  // const pmCount = db.exec('SELECT COUNT(*) FROM payment_methods')[0]?.values[0][0] || 0;
  // if (pmCount === 0) {
  //   DEFAULT_PAYMENT_METHODS.forEach((name, i) => {
  //     db.run('INSERT OR IGNORE INTO payment_methods (name, sort_order) VALUES (?, ?)', [name, i + 1]);
  //   });
  //   Object.entries(DEFAULT_CATEGORIES).forEach(([cat, subs], catIdx) => {
  //     db.run('INSERT OR IGNORE INTO budget_categories (name, sort_order) VALUES (?, ?)', [cat, catIdx + 1]);
  //     subs.forEach((sub, subIdx) => {
  //       db.run('INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)', [cat, sub, subIdx + 1]);
  //     });
  //   });
  // }

  return didMigrate;
}
