import React, { useMemo } from 'react';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 달력 셀 금액 포맷: 단위에 따라 변환
function formatCellAmount(net, unit) {
  if (unit === 'hidden') return null;
  if (unit === 'k') {
    if (net >= 1000) return `${Math.round(net / 1000)}k`;
    return String(net);
  }
  // 만 단위 (기본)
  if (net >= 100000000) return `${+(net / 100000000).toFixed(1)}억`;
  if (net >= 10000) return `${+(net / 10000).toFixed(1).replace(/\.0$/, '')}만`;
  return String(net);
}

function CalendarMini({ month, dailyTotals, onDateClick, focusedDate, amountUnit = '만' }) {
  // month: 'YYYY-MM'
  const { year, mon, days, firstDow } = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const firstDay = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0);
    return { year: y, mon: m, days: lastDay.getDate(), firstDow: firstDay.getDay() };
  }, [month]);

  // 최대 지출액 (히트맵 강도 계산용)
  const maxTotal = useMemo(() => {
    const vals = Object.values(dailyTotals).map(d => d.total - d.discount);
    return vals.length ? Math.max(...vals) : 0;
  }, [dailyTotals]);

  const cells = [];
  // 앞 빈칸
  for (let i = 0; i < firstDow; i++) {
    cells.push(null);
  }
  // 날짜
  for (let d = 1; d <= days; d++) {
    cells.push(d);
  }

  return (
    <div className="cal-mini">
      <div className="cal-mini-grid">
        {WEEKDAYS.map((wd, i) => (
          <div key={wd} className={`cal-mini-wd ${i === 0 ? 'cal-sun' : i === 6 ? 'cal-sat' : ''}`}>
            {wd}
          </div>
        ))}
        {cells.map((day, idx) => {
          if (!day) return <div key={`e-${idx}`} className="cal-mini-cell cal-mini-empty" />;
          const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const info = dailyTotals[dateStr];
          const net = info ? info.total - info.discount : 0;
          const ratio = maxTotal > 0 && net > 0 ? net / maxTotal : 0;
          const dow = (firstDow + day - 1) % 7;
          const isFocused = focusedDate === dateStr;

          return (
            <button
              key={dateStr}
              className={`cal-mini-cell${info ? ' cal-mini-has-tx' : ''}${isFocused ? ' cal-mini-focused' : ''}${dow === 0 ? ' cal-sun' : dow === 6 ? ' cal-sat' : ''}`}
              onClick={() => onDateClick(dateStr)}
              style={ratio > 0 ? { '--heat': ratio } : undefined}
              title={info ? `${net.toLocaleString()}원 (${info.count}건)` : undefined}
            >
              <span className="cal-mini-day">{day}</span>
              {info && amountUnit !== 'hidden' && (
                <span className="cal-mini-amount">
                  {formatCellAmount(net, amountUnit)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default CalendarMini;
