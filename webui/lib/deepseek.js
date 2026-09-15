'use strict';
/**
 * 大脑层：DeepSeek（deepseek-flash，多模态）调用。
 * 实证：https://api.deepseek.com/models 只提供 deepseek-flash / deepseek-v4-pro；
 * deepseek-flash 支持 base64 图片输入（外链图片拉不到，必须内联）。
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { looseJson } = require('./util');

const DEFAULT_BASE = 'https://api.deepseek.com';

class Brain {
  constructor({ baseUrl, apiKey, model = 'deepseek-flash', onLog = () => {} }) {
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.onLog = onLog;
    this.usage = { prompt: 0, completion: 0, calls: 0 };
  }

  async #post(pathname, body, timeoutMs) {
    if (!this.apiKey) throw new Error('DeepSeek API Key 缺失：请检查 webui/config.json 或 hermes/.env 里的 DEEPSEEK_API_KEY');
    const res = await fetch(this.baseUrl + pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 300000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 下面统一报错 */ }
    if (!res.ok) {
      const detail = json ? JSON.stringify(json).slice(0, 600) : text.slice(0, 600);
      throw new Error(`DeepSeek HTTP ${res.status}: ${detail}`);
    }
    const u = json?.usage;
    if (u) {
      this.usage.prompt += u.prompt_tokens || 0;
      this.usage.completion += u.completion_tokens || 0;
    }
    this.usage.calls += 1;
    return json;
  }

  async chat(messages, { maxTokens = 8000, temperature = 0.6, label = 'LLM', json = false, timeoutMs } = {}) {
    const t0 = Date.now();
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (json) body.response_format = { type: 'json_object' };
    let json2;
    try {
      json2 = await this.#post('/chat/completions', body, timeoutMs);
    } catch (err) {
      // 有些实现不认 response_format，去掉重试一次
      if (json && /400|response_format/i.test(String(err.message))) {
        delete body.response_format;
        json2 = await this.#post('/chat/completions', body, timeoutMs);
      } else { throw err; }
    }
    const msg = json2?.choices?.[0]?.message || {};
    const content = msg.content || '';
    this.onLog(`[大脑] ${label} 完成 ${(Date.now() - t0) / 1000}s · tokens ${json2?.usage?.total_tokens ?? '?'}`, 'info');
    return { content, raw: json2 };
  }

  /** 读一张或多张本地图片（base64 内联） */
  async visionAsk(imagePaths, prompt, { maxTokens = 4000, label = '读图', temperature = 0.3, detail = 'high' } = {}) {
    const parts = [{ type: 'text', text: prompt }];
    for (const p of imagePaths) {
      const buf = await fsp.readFile(p);
      const ext = path.extname(p).toLowerCase().replace('.', '') || 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${buf.toString('base64')}`, detail },
      });
    }
    const { content } = await this.chat([{ role: 'user', content: parts }],
      { maxTokens, temperature, label });
    return content;
  }

  async chatJson(messages, opts = {}) {
    const { content } = await this.chat(messages, { ...opts, json: true });
    const parsed = looseJson(content);
    if (!parsed) {
      throw new Error(`模型未返回可解析 JSON（${opts.label || 'LLM'}）：${content.slice(0, 300)}`);
    }
    return parsed;
  }
}

module.exports = { Brain };
