import React, { useState } from 'react';
import { PROVIDERS, getAIConfig, saveAIConfig, listModels } from '../../services/aiClient';
import './ReceiptScanner.css';

/**
 * AI 영수증 분석 설정 — 공급자 선택, API 키, 모델.
 * 설정 화면과 영수증 스캐너(처음 사용할 때) 양쪽에서 쓴다.
 * 키는 이 기기에만 저장된다.
 */
export default function AISettingsForm({ onSaved, onCancel, compact = false }) {
  const [config, setConfig] = useState(getAIConfig);
  const [models, setModels] = useState([]);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState(null); // { ok, text }

  const provider = config.provider;
  const info = PROVIDERS[provider];
  const apiKey = config.keys[provider] || '';
  const model = config.models[provider] || info.defaultModel;

  const update = (patch) => {
    setConfig(c => ({
      provider: patch.provider ?? c.provider,
      keys: { ...c.keys, ...(patch.keys || {}) },
      models: { ...c.models, ...(patch.models || {}) },
    }));
  };

  const switchProvider = (p) => {
    update({ provider: p });
    setModels([]);
    setStatus(null);
  };

  const checkConnection = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const list = await listModels(provider, apiKey.trim());
      setModels(list);
      if (list.length && !list.includes(config.models[provider])) {
        update({ models: { [provider]: list[0] } });
      }
      setStatus({ ok: true, text: `연결됨 · 사용 가능한 모델 ${list.length}개` });
    } catch (e) {
      setStatus({ ok: false, text: e.message });
    } finally {
      setChecking(false);
    }
  };

  const save = () => {
    const next = {
      ...config,
      keys: { ...config.keys, [provider]: apiKey.trim() },
      models: { ...config.models, [provider]: model },
    };
    saveAIConfig(next);
    setStatus({ ok: true, text: '저장했습니다' });
    if (onSaved) onSaved(next);
  };

  const removeKey = () => {
    const next = { ...config, keys: { ...config.keys, [provider]: '' } };
    saveAIConfig(next);
    setConfig(next);
    setModels([]);
    setStatus({ ok: true, text: '이 기기에서 키를 삭제했습니다' });
  };

  const modelOptions = models.length ? models : [model];

  return (
    <div className={`ai-settings${compact ? ' ai-settings--compact' : ''}`}>
      <div className="ai-field">
        <label>사용할 AI</label>
        <div className="ai-provider-row">
          {Object.entries(PROVIDERS).map(([key, p]) => (
            <button
              key={key}
              type="button"
              className={`ai-provider${provider === key ? ' active' : ''}`}
              onClick={() => switchProvider(key)}
            >{p.label}</button>
          ))}
        </div>
      </div>

      <div className="ai-field">
        <label>API 키</label>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={e => { update({ keys: { [provider]: e.target.value } }); setStatus(null); }}
          placeholder={info.keyPlaceholder}
        />
        <span className="ai-help">{info.keyHelp}</span>
      </div>

      <div className="ai-field">
        <label>모델</label>
        <div className="ai-model-row">
          <select value={model} onChange={e => update({ models: { [provider]: e.target.value } })}>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <button type="button" className="ai-btn-secondary" disabled={!apiKey.trim() || checking} onClick={checkConnection}>
            {checking ? '확인 중…' : '연결 확인'}
          </button>
        </div>
        {status && <span className={`ai-status${status.ok ? ' ok' : ' err'}`}>{status.text}</span>}
      </div>

      <div className="ai-privacy">
        영수증 사진과 함께 <b>결제수단·카테고리 목록</b>과 <b>최근 세부내역 입력 습관</b>(가게 이름·분류·횟수)이
        선택한 AI로 전송됩니다. API 키는 <b>이 기기에만</b> 저장되고 가족 공용 가계부 파일에는 들어가지 않습니다.
      </div>

      <div className="ai-actions">
        {config.keys[provider] && !compact && (
          <button type="button" className="ai-btn-danger" onClick={removeKey}>키 삭제</button>
        )}
        {onCancel && <button type="button" className="ai-btn-secondary" onClick={onCancel}>취소</button>}
        <button type="button" className="ai-btn-primary" disabled={!apiKey.trim()} onClick={save}>
          {compact ? '저장하고 계속' : '저장'}
        </button>
      </div>
    </div>
  );
}
