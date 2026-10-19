/**
 * MIU 联动（MIU <-> TauriTavern）
 * ------------------------------------------------------------------
 * 把酒馆（TauriTavern）里的角色卡推进 MIU 安卓 App。
 *
 * 走 TT 自带的本机 MCP 客户端（Rust 侧直连 127.0.0.1），所以不受正式版
 * TT「禁止明文 HTTP」的限制；不登录账号、不上云，数据只在你这台手机里走。
 *
 * 用法：先在 MIU 里「设置 -> TauriTavern -> 开启接收服务」，再回到这里点「连接 MIU」。
 */
(function () {
    'use strict';

    const DISPLAY_NAME = 'MIU 联动';
    const MODULE_NAME = 'miuBridge';
    const CANDIDATE_PORTS = [8791, 8792, 8793, 8794, 8795];
    const CHUNK_BYTES = 48 * 1024;
    const MAX_CARD_BYTES = 32 * 1024 * 1024;
    /** 这一版的小标记：TT 面板上直接能看到，用来确认它跑的是不是新文件（版号没动，只能靠这个认）。 */
    const BUILD_TAG = '10-19 TT分类按需拉取';
    /** 小头像：最长边、JPEG 质量、单张 base64 上限、加载超时。 */
    const THUMB_MAX_SIDE = 112;
    const THUMB_QUALITY = 0.72;
    const THUMB_MAX_CHARS = 400 * 1024;
    /** 单张头像的字节上限，以及整个渲染过程的时间预算。 */
    const THUMB_MAX_BYTES = 400 * 1024;
    const THUMB_TOTAL_MS = 4000;
    const THUMB_TIMEOUT_MS = 5000;
    /** 一轮轮询最多渲染几张，别把轮询占太久。 */
    const THUMB_PER_ROUND = 12;
    /** MIU 拉取支持哪几类（和 MIU 界面上的分类一致）。 */
    const PULL_KINDS = ['character', 'worldbook', 'preset', 'theme', 'qr', 'regex'];
    const PULL_KIND_LABEL = {
        character: '角色卡',
        worldbook: '世界书',
        preset: '预设',
        theme: '美化',
        qr: '快速回复',
        regex: '正则',
    };
    const TOOL_NAMES = [
        'miu_ping', 'miu_status', 'miu_push_begin',
        'miu_push_chunk', 'miu_push_end', 'miu_push_abort', 'miu_list_pending',
        'miu_outbox_list', 'miu_outbox_fetch', 'miu_outbox_ack', 'miu_outbox_clear',
        'miu_pull_state', 'miu_pull_list', 'miu_pull_report',
        'miu_thumb_data', 'miu_pull_error',
    ];

    const ERRORS = {
        host_unavailable: '这个 TT 版本没有联动能力，需要官方 TauriTavern 2.3.0 或更高版本。',
        no_receiver: '没找到 MIU 接收服务。请先打开 MIU -> 设置 -> TauriTavern -> 开启接收服务。',
        not_connected: '还没连上 MIU，先点「连接 MIU」。',
        export_failed: 'TT 导出这张角色卡失败（可能它不是 PNG 卡）。',
        size_limit: '这张卡超过了单张 32 MB 的上限。',
        bridge_unavailable: '联动通道暂时连不上 MIU（MIU 可能被系统冻结了，切回 MIU 一次再试）。',
        bridge_rejected: 'MIU 没有接受这次请求，请确认 MIU 里的接收服务还开着。',
        bridge_bad_response: 'MIU 的响应无法识别，可能两端版本不一致。',
        catalog_failed: '读取 TT 的角色列表失败。',
        select_character: '请先在 TT 里选中一张角色卡。',
        import_failed: '酒馆拒绝了这次导入（这张卡可能已经存在，或格式不对）。',
        unknown_card: '这张卡在 MIU 里已经不在待发送列表了。',
        preset_import_failed: '酒馆拒绝了这个预设（数据可能不是预设格式）。',
        theme_import_failed: '酒馆拒绝了这个美化主题。',
        qr_import_failed: '酒馆拒绝了这个快速回复集合。',
        regex_import_failed: '写不进正则：这里不是酒馆页面内部。',
        unsupported_script: '这份「脚本」不是酒馆正则（酒馆助手那种 JS 脚本没有导入接口），没推过去，还留在 MIU 队列里。',
        unknown_json: '认不出这份 JSON 是哪一类数据（角色卡 / 世界书 / 预设 / 美化 / 快速回复 / 正则），没敢直接导，还留在 MIU 队列里。',
    };

    const state = {
        registrationId: null,
        port: 0,
        connected: false,
        busy: false,
        callMode: null,
        /** 正在处理 MIU 的拉取请求，避免轮询重复触发。 */
        pullBusy: false,
        /** 最近一次拿到的酒馆列表，用来给拉取的项补名字。 */
        catalog: [],
        /** 工具类拉取用的正文缓存：id -> { kind, name, apiId, payload }。 */
        toolData: new Map(),
        /** 工具目录最近刷新时间。 */
        toolDataAt: 0,
    };

    let settingsModule = null;

    // ------------------------------------------------------------------
    // 宿主 / 设置
    // ------------------------------------------------------------------

    function host() {
        const value = window.__TAURITAVERN__;
        if (!value || !value.api || !value.api.mcp || !value.invoke || typeof value.invoke.safeInvoke !== 'function') {
            throw new Error('host_unavailable');
        }
        return value;
    }

    async function hostReady() {
        const pending = window.__TAURITAVERN__ && window.__TAURITAVERN__.ready
            ? window.__TAURITAVERN__.ready
            : window.__TAURITAVERN_MAIN_READY__;
        if (pending && typeof pending.then === 'function') {
            try { await pending; } catch (error) { /* 就绪失败后面会照常报错 */ }
        }
        return host();
    }

    async function extSettings() {
        if (!settingsModule) {
            settingsModule = await import('../../../extensions.js');
        }
        if (!settingsModule.extension_settings) {
            settingsModule.extension_settings = {};
        }
        if (!settingsModule.extension_settings[MODULE_NAME]) {
            settingsModule.extension_settings[MODULE_NAME] = {};
        }
        return settingsModule.extension_settings[MODULE_NAME];
    }

    async function saveSettings() {
        try {
            const module = await import('../../../../script.js');
            if (typeof module.saveSettingsDebounced === 'function') module.saveSettingsDebounced();
        } catch (error) { /* 存不下不影响本次使用 */ }
    }

    async function requestHeaders() {
        const module = await import('../../../../script.js');
        if (typeof module.getRequestHeaders !== 'function') throw new Error('host_unavailable');
        return module.getRequestHeaders();
    }

    // ------------------------------------------------------------------
    // 界面
    // ------------------------------------------------------------------

    function setStatus(text, kind) {
        const element = document.getElementById('miu_bridge_status');
        if (!element) return;
        element.textContent = text;
        element.classList.remove('miu-ok', 'miu-error');
        if (kind === 'ok') element.classList.add('miu-ok');
        if (kind === 'error') element.classList.add('miu-error');
    }

    function log(text) {
        const box = document.getElementById('miu_bridge_log');
        if (!box) return;
        const line = '[' + new Date().toLocaleTimeString() + '] ' + text + '\n';
        box.textContent = (line + box.textContent).slice(0, 8000);
    }

    function describe(error) {
        const code = error && error.message ? error.message : String(error);
        return ERRORS[code] || ('出错了：' + code);
    }

    function buildHtml() {
        return `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>MIU 联动</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="miu-bridge-block">
      <div class="miu-bridge-status" id="miu_bridge_status">未连接</div>
      <div class="miu-bridge-row">
        <div class="menu_button" id="miu_bridge_connect">连接 MIU</div>
        <div class="menu_button" id="miu_bridge_push_current">推送当前角色</div>
        <div class="menu_button" id="miu_bridge_push_all">推送全部角色卡</div>
        <div class="menu_button" id="miu_bridge_pending">查看待接收</div>
        <div class="menu_button" id="miu_bridge_receive">接收 MIU 推送</div>
      </div>
      <details class="miu-bridge-help">
        <summary>怎么用 / 连不上怎么办（扩展 ${BUILD_TAG}）</summary>
        <ol>
          <li>打开 MIU（安卓）→ 设置 → TauriTavern → 点「开启接收服务」，看到端口号就算好了。</li>
          <li>回到 TT 这一页，点「连接 MIU」。连上会显示 MIU 的端口和待接收数量。</li>
          <li>点「推送当前角色」或「推送全部角色卡」，等进度跑完。</li>
          <li>切回 MIU → 设置 → TauriTavern → 点「选择要导入的卡」，勾选后导入。</li>
        </ol>
        <p><b>反向（MIU → 酒馆）</b>：在 MIU 里进角色卡详情页点纸飞机「发送到酒馆」，在弹出的选项里选「发送到酒馆（TT 联动）」，卡就会排进 MIU 的「待发送到酒馆」；回到这里点「接收 MIU 推送」导入酒馆。按钮上的数字就是 MIU 里排队的张数（每 3 秒自动刷新）。角色卡 / 世界书 / 预设 / 美化 / 快速回复都能这样推；正则也走这条路，但只在 TT 里有效（酒馆没开出导入接口）。</p>
        <p><b>MIU 主动拉取（酒馆 → MIU）</b>：在 MIU 里点「拉取 TauriTavern」，勾选想拉进来的卡，这边会自动把卡送过去，本页不用点任何按钮。拉的时候 TT 保持运行（挂小窗最稳）。</p>
        <p>连不上时：先确认 MIU 的接收服务开着；再确认 MIU 没有被系统冻结（可以分屏或锁定后台）。安卓切后台会冻结 App，所以推完请尽快切回 MIU 导入。</p>
      </details>
      <div class="miu-bridge-log" id="miu_bridge_log"></div>
    </div>
  </div>
</div>`;
    }

    // ------------------------------------------------------------------
    // 与 MIU 通信（TT 原生 MCP 客户端）
    // ------------------------------------------------------------------

    function isOurEndpoint(endpoint) {
        return typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint);
    }

    function portOf(endpoint) {
        const match = /^http:\/\/127\.0\.0\.1:(\d+)\/mcp$/.exec(String(endpoint || ''));
        return match ? Number(match[1]) : 0;
    }

    async function forgetOurRegistrations() {
        const api = host().api.mcp;
        let servers = [];
        try {
            const listed = await api.servers.list();
            servers = (listed && Array.isArray(listed.servers)) ? listed.servers : [];
        } catch (error) {
            return;
        }
        for (const server of servers) {
            if (!server || server.displayName !== DISPLAY_NAME || !isOurEndpoint(server.endpoint)) continue;
            try { await api.servers.remove(server.id); } catch (error) { /* 删不掉就留着，不致命 */ }
        }
    }

    async function ensurePermissions(tools) {
        const api = host().api.mcp;
        const names = Array.isArray(tools) && tools.length
            ? tools.map(tool => tool && tool.nativeName).filter(name => typeof name === 'string')
            : TOOL_NAMES;
        for (const name of names) {
            if (name.indexOf('miu_') !== 0) continue;
            try {
                await api.tools.setPermission({ registrationId: state.registrationId, nativeName: name, permission: 'allow' });
            } catch (error) { /* 权限设不上就靠 ask，不阻断 */ }
        }
    }

    function unwrapToolResult(result) {
        if (!result || result.outcome !== 'known_response') throw new Error('bridge_unavailable');
        const response = result.response;
        if (!response || response.kind !== 'tool_result') throw new Error('bridge_rejected');
        const text = response.structuredJson
            || (Array.isArray(response.textBlocks) ? response.textBlocks.map(block => block.text).join('') : '');
        let value = null;
        if (text) {
            try { value = JSON.parse(text); } catch (error) { throw new Error('bridge_bad_response'); }
        }
        if (response.isError) {
            throw new Error((value && value.error) ? value.error : 'bridge_rejected');
        }
        if (!value) throw new Error('bridge_bad_response');
        return value;
    }

    async function callToolLegacy(nativeName, argumentsJson) {
        const safeInvoke = host().invoke.safeInvoke;
        const executionCallId = crypto.randomUUID();
        await safeInvoke('start_legacy_mcp_tool_call', { dto: { executionCallId } });
        const result = await safeInvoke('call_legacy_mcp_tool', {
            dto: {
                executionCallId,
                toolId: 'mcp/' + state.registrationId + ':' + nativeName,
                argumentsJson,
            },
        });
        return unwrapToolResult(result);
    }

    async function callTool(nativeName, args) {
        if (!state.registrationId) throw new Error('not_connected');
        const argumentsJson = JSON.stringify(args || {});

        if (state.callMode !== 'legacy') {
            let outcome;
            try {
                outcome = await host().api.mcp.tools.testCall({
                    registrationId: state.registrationId,
                    nativeName,
                    argumentsJson,
                });
            } catch (error) {
                if (state.callMode === 'test') throw error;
                state.callMode = 'legacy';
                return callToolLegacy(nativeName, argumentsJson);
            }
            state.callMode = 'test';
            return unwrapToolResult(outcome);
        }

        return callToolLegacy(nativeName, argumentsJson);
    }

    function orderedPorts() {
        const ports = [];
        if (state.port > 0) ports.push(state.port);
        for (const port of CANDIDATE_PORTS) {
            if (ports.indexOf(port) < 0) ports.push(port);
        }
        return ports;
    }

    async function connect() {
        const api = (await hostReady()).api.mcp;
        await forgetOurRegistrations();

        const settings = await extSettings();
        state.port = Number(settings.port) > 0 ? Number(settings.port) : 0;

        let reachedMiu = false;
        let lastError = null;

        for (const port of orderedPorts()) {
            let created = null;
            try {
                created = await api.servers.create({
                    displayName: DISPLAY_NAME,
                    endpoint: 'http://127.0.0.1:' + port + '/mcp',
                    headers: {},
                    protocolVersion: 'auto',
                });
                await api.servers.setState({ registrationId: created.id, state: 'active' });
                const discovery = await api.servers.discover(created.id);
                const tools = (discovery && Array.isArray(discovery.tools)) ? discovery.tools : [];
                if (!tools.some(tool => tool && tool.nativeName === 'miu_ping')) throw new Error('not_miu');
                reachedMiu = true;

                state.registrationId = created.id;
                state.port = port;
                state.callMode = null;
                await ensurePermissions(tools);

                const info = await callTool('miu_ping', {});
                if (!info || info.ok !== true || info.app !== 'miu') throw new Error('not_miu');

                settings.port = port;
                await saveSettings();
                state.connected = true;
                return info;
            } catch (error) {
                lastError = error;
                state.registrationId = null;
                state.connected = false;
                state.callMode = null;
                if (created) {
                    try { await api.servers.remove(created.id); } catch (ignore) { /* 清理失败无所谓 */ }
                }
            }
        }

        // 有到过 MIU 但没连成，就把真实原因抛出去，别一律说「没找到服务」
        throw (reachedMiu && lastError) ? lastError : new Error('no_receiver');
    }

    async function ensureConnected() {
        if (state.connected && state.registrationId) return;
        await connect();
    }

    async function refreshStatus() {
        const info = await callTool('miu_status', {});
        state.connected = true;
        setStatus('已连接 MIU · 端口 ' + info.port + ' · 待接收 ' + info.pending + ' 张（累计 ' + info.total + ' 张）', 'ok');
        return info;
    }

    // ------------------------------------------------------------------
    // 角色卡
    // ------------------------------------------------------------------

    function bytesToBase64(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
            binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 8192, bytes.length)));
        }
        return btoa(binary);
    }

    function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    /** 角色卡文件名：统一带上合法后缀，避免酒馆拒收。 */
    function cardFileName(name) {
        const value = String(name || 'miu_card').replace(/[\\/]/g, '_').trim() || 'miu_card';
        return /\.(png|jpe?g|webp|json)$/i.test(value) ? value : value + '.png';
    }

    async function exportCard(avatar) {
        const headers = await requestHeaders();
        const cleanAvatar = String(avatar || '').replace(/^[\/\\]+/, '');
        const response = await fetch('/api/characters/export', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar: cleanAvatar, avatar_url: cleanAvatar, file_name: cleanAvatar, format: 'png' }),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('export_failed');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 8 || bytes.length > MAX_CARD_BYTES) throw new Error('size_limit');
        return bytes;
    }

    /** 酒馆前端上下文：角色列表和缩略图地址都从这里拿，不用碰 HTTP 接口。 */
    function contextApi() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext() || null;
            }
        } catch (error) { /* 拿不到就当没有 */ }
        return null;
    }

    /** 酒馆内存里已经加载好的角色列表（最快，发送前不用等下载）。 */
    function catalogueFromContext() {
        const context = contextApi();
        const characters = context && Array.isArray(context.characters) ? context.characters : null;
        if (!characters) return null;
        return characters
            .filter(character => character && typeof character.avatar === 'string' && character.avatar)
            .map(character => ({
                id: character.avatar,
                kind: 'character',
                avatar: character.avatar,
                name: String(character.name || '角色卡').slice(0, 120),
            }));
    }

    /** 优先用内存里的列表；内存里没有才让酒馆重新加载；最后才退回接口。 */
    async function listCharacters() {
        let list = catalogueFromContext();
        if (list && list.length > 0) return list;

        try {
            const context = contextApi();
            if (context && typeof context.getCharacters === 'function') await context.getCharacters();
        } catch (error) { /* 刷不出来再走接口 */ }
        list = catalogueFromContext();
        if (list && list.length > 0) return list;

        const response = await fetch('/api/characters/all', {
            method: 'POST',
            headers: await requestHeaders(),
            body: '{}',
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('catalog_failed');
        const remote = await response.json();
        if (!Array.isArray(remote)) throw new Error('catalog_failed');
        return remote
            .filter(character => character && typeof character.avatar === 'string' && character.avatar)
            .map(character => ({
                id: character.avatar,
                kind: 'character',
                avatar: character.avatar,
                name: String(character.name || '角色卡').slice(0, 120),
            }));
    }

    /** 酒馆的设置/预设/主题/快速回复目录（一次拿全，列表只发名字）。 */
    async function postTavernJson(path, body) {
        const headers = await requestHeaders();
        headers['Content-Type'] = 'application/json';
        const response = await fetch(path, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body || {}),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('catalog_failed');
        return response.json();
    }

    function parseSettingsObject(data) {
        if (data && data.settings && typeof data.settings === 'string') {
            try { return JSON.parse(data.settings); } catch (error) { return {}; }
        }
        return (data && typeof data.settings === 'object' && data.settings) ? data.settings : {};
    }

    function asObject(value) {
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
            } catch (error) { return null; }
        }
        return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
    }

    function asArray(value) {
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) { return []; }
        }
        return [];
    }

    /** 设置接口和酒馆页面内存合并取数：TT 的接口偶尔不给工具目录，页面里其实有。 */
    function betterArray(primary, fallback) {
        const p = asArray(primary);
        const f = asArray(fallback);
        return p.length > 0 ? p : f;
    }

    function mergedToolSource(data) {
        const api = asObject(data) || {};
        const nested = asObject(api.settings) || {};
        const context = contextApi() || {};
        const source = Object.assign({}, context, api, nested);
        const extensionSettings = asObject(api.extension_settings)
            || asObject(nested.extension_settings)
            || asObject(context.extensionSettings)
            || asObject(context.extension_settings)
            || {};
        source.extension_settings = extensionSettings;
        source.settings = Object.keys(nested).length > 0 ? nested : (asObject(api.settings) || {});
        source.world_names = betterArray(source.world_names, context.world_names);
        source.openai_settings = betterArray(source.openai_settings, context.openai_settings);
        source.openai_setting_names = betterArray(source.openai_setting_names, context.openai_setting_names);
        source.textgenerationwebui_presets = betterArray(source.textgenerationwebui_presets, context.textgenerationwebui_presets);
        source.textgenerationwebui_preset_names = betterArray(source.textgenerationwebui_preset_names, context.textgenerationwebui_preset_names);
        source.koboldai_settings = betterArray(source.koboldai_settings, context.koboldai_settings);
        source.koboldai_setting_names = betterArray(source.koboldai_setting_names, context.koboldai_setting_names);
        source.novelai_settings = betterArray(source.novelai_settings, context.novelai_settings);
        source.novelai_setting_names = betterArray(source.novelai_setting_names, context.novelai_setting_names);
        source.themes = betterArray(source.themes, context.themes);
        source.quickReplyPresets = betterArray(source.quickReplyPresets, context.quickReplyPresets);
        return source;
    }

    function normalizePresetApi(value) {
        const api = String(value || '').toLowerCase();
        if (api === 'koboldhorde') return 'kobold';
        if (api === 'kobold') return 'kobold';
        if (api === 'novel') return 'novel';
        if (api === 'textgenerationwebui') return 'textgenerationwebui';
        if (api === 'openai') return 'openai';
        return '';
    }

    /** 真预设：必须有提示词/顺序，或采样参数；脚本类（type=script）一律不要。 */
    function isRealPreset(preset) {
        if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return false;
        const type = String(preset.type || '').toLowerCase();
        if (type === 'script' || type === 'tool') return false;
        if (Array.isArray(preset.prompts) || Array.isArray(preset.prompt_order) || Array.isArray(preset.promptOrder)) return true;
        const samplers = ['temperature', 'top_p', 'top_k', 'temp', 'rep_pen', 'repetition_penalty', 'openai_max_tokens', 'max_tokens'];
        return samplers.some(key => typeof preset[key] === 'number');
    }

    function toolEntriesFromSettings(data) {
        const entries = [];
        const dataMap = new Map();
        const source = mergedToolSource(data);
        const settings = asObject(source.settings) || {};
        const activeApi = normalizePresetApi(settings.main_api || source.main_api || settings.api_server || source.api_server || '');
        const add = (id, kind, name, payload, apiId, sub) => {
            const item = { id: id, kind: kind, name: String(name || kind).slice(0, 160), apiId: apiId || '', sub: sub || '' };
            entries.push(item);
            dataMap.set(id, { id: id, kind: kind, name: item.name, apiId: apiId || '', sub: sub || '', payload: payload });
        };

        const worlds = asArray(source.world_names);
        worlds.forEach((rawName, index) => {
            const clean = String(rawName || '').trim();
            if (!clean) return;
            add('wb:' + index + ':' + clean, 'worldbook', clean, null, '', '');
        });

        const presetGroups = [
            { contents: asArray(source.openai_settings), names: asArray(source.openai_setting_names), apiId: 'openai' },
            { contents: asArray(source.textgenerationwebui_presets), names: asArray(source.textgenerationwebui_preset_names), apiId: 'textgenerationwebui' },
            { contents: asArray(source.koboldai_settings), names: asArray(source.koboldai_setting_names), apiId: 'kobold' },
            { contents: asArray(source.novelai_settings), names: asArray(source.novelai_setting_names), apiId: 'novel' },
        ];
        const selectedGroups = activeApi
            ? presetGroups.filter(group => group.apiId === activeApi)
            : presetGroups.filter(group => group.apiId === 'openai');
        const groupsToRead = selectedGroups.length > 0 ? selectedGroups : presetGroups.filter(group => group.apiId === 'openai');
        groupsToRead.forEach(group => {
            group.contents.forEach((rawPreset, index) => {
                const preset = asObject(rawPreset);
                if (!preset || !isRealPreset(preset)) return;
                const rawName = (Array.isArray(group.names) && group.names[index]) || preset.name || ('预设 ' + (index + 1));
                const name = String(rawName).slice(0, 160);
                add('preset:' + group.apiId + ':' + index + ':' + name, 'preset', name, preset, group.apiId, '');
            });
        });

        const themes = asArray(source.themes);
        themes.forEach((rawTheme, index) => {
            const theme = asObject(rawTheme);
            if (!theme) return;
            const name = String(theme.name || theme.theme_name || ('美化 ' + (index + 1))).slice(0, 160);
            add('theme:' + index + ':' + name, 'theme', name, theme, '', '');
        });

        const quickReplies = asArray(source.quickReplyPresets);
        quickReplies.forEach((rawSet, index) => {
            const set = asObject(rawSet);
            if (!set) return;
            const name = String(set.name || set.displayName || ('快速回复 ' + (index + 1))).slice(0, 160);
            add('qr:' + index + ':' + name, 'qr', name, set, '', '');
        });

        const regex = asArray(source.extension_settings && source.extension_settings.regex);
        regex.forEach((rawScript, index) => {
            const script = asObject(rawScript);
            if (!script) return;
            const name = String(script.scriptName || script.name || ('正则 ' + (index + 1))).slice(0, 160);
            add('regex:' + index + ':' + name, 'regex', name, script, '', '');
        });

        return { entries: entries, dataMap: dataMap };
    }

    /** 拉取列表时把工具目录也带上；正文先放在内存里，选中后才发。 */
    async function loadToolCatalog(force) {
        const fresh = state.toolDataAt > 0 && (Date.now() - state.toolDataAt) < 5 * 60 * 1000;
        if (!force && fresh) return Array.from(state.toolData.values()).map(item => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
            apiId: item.apiId,
            sub: item.sub,
        }));
        let data = {};
        try {
            data = await postTavernJson('/api/settings/get', {});
        } catch (error) {
            log('设置接口没返回工具目录，改用酒馆页面内存读取：' + describe(error));
        }
        const parsed = toolEntriesFromSettings(data || {});
        state.toolData = parsed.dataMap;
        state.toolDataAt = Date.now();
        return parsed.entries;
    }

    /** 从列表 id 里还原名字（扩展重载后 state 丢了也能用）。 */
    function toolNameFromId(id) {
        const parts = String(id || '').split(':');
        if (parts[0] === 'preset') return parts.slice(3).join(':');
        return parts.slice(2).join(':');
    }

    function toolFileName(name, kind) {
        const base = String(name || 'miu_tool').replace(/[\\/:*?"<>|]/g, '_').trim() || 'miu_tool';
        const suffix = '.' + kind + '.json';
        const lower = base.toLowerCase();
        return lower.endsWith(suffix) ? base : base.replace(/\.json$/i, '') + suffix;
    }

    /** 取一项工具的正文；世界书按名字现取，其它用目录里的对象。 */
    async function resolveToolPayload(id, info) {
        let tool = state.toolData.get(id);
        if (!tool) {
            await loadToolCatalog(true);
            tool = state.toolData.get(id);
        }
        if (!tool) throw new Error('unknown_card');
        if (tool.kind === 'worldbook') {
            const name = tool.name || toolNameFromId(id);
            const body = await postTavernJson('/api/worldinfo/get', { name: name });
            return body;
        }
        return tool.payload;
    }

    async function pushBytes(name, bytes, thumb) {
        const begin = await callTool('miu_push_begin', {
            name: name,
            bytes: bytes.length,
            thumb: thumb || '',
        });
        const operationId = begin && begin.operationId;
        if (!operationId) throw new Error('bridge_bad_response');
        try {
            const total = Math.ceil(bytes.length / CHUNK_BYTES);
            for (let index = 0; index < total; index++) {
                const slice = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.length));
                await callTool('miu_push_chunk', { operationId: operationId, index: index, data: bytesToBase64(slice) });
                if (total > 1) setStatus('正在推送 ' + name + '：' + (index + 1) + ' / ' + total + ' 片');
            }
            return await callTool('miu_push_end', { operationId: operationId });
        } catch (error) {
            try { await callTool('miu_push_abort', { operationId: operationId }); } catch (ignore) { /* 放弃失败也无所谓 */ }
            throw error;
        }
    }

    function currentCharacter() {
        const context = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
            ? window.SillyTavern.getContext()
            : null;
        if (!context || context.groupId) return null;
        const index = context.characterId;
        const character = (index !== undefined && index !== null && index !== '')
            ? (context.characters ? context.characters[index] : null)
            : null;
        if (!character || !character.avatar) return null;
        return { avatar: character.avatar, name: String(character.name || '角色卡').slice(0, 120) };
    }

    async function pushOne(character, label) {
        const bytes = await exportCard(character.avatar);
        const thumbInfo = await renderThumb(character.avatar);
        const begin = await callTool('miu_push_begin', {
            name: character.name || character.avatar,
            bytes: bytes.length,
            thumb: thumbInfo.data,
        });
        const operationId = begin && begin.operationId;
        if (!operationId) throw new Error('bridge_bad_response');

        try {
            const total = Math.ceil(bytes.length / CHUNK_BYTES);
            for (let index = 0; index < total; index++) {
                const slice = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.length));
                await callTool('miu_push_chunk', { operationId, index, data: bytesToBase64(slice) });
                if (total > 1) setStatus('正在推送 ' + label + '：' + (index + 1) + ' / ' + total + ' 片');
            }
            return await callTool('miu_push_end', { operationId });
        } catch (error) {
            try { await callTool('miu_push_abort', { operationId }); } catch (ignore) { /* 放弃失败也无所谓 */ }
            throw error;
        }
    }

    /** 内存头像缩略图缓存：避免重复抓取或渲染同一个 avatar */
    const THUMB_CACHE = new Map();

    /** 这张卡的头像地址候选：先问酒馆上下文，再按酒馆的缩略图和角色静态资源地址匹配。 */
    function thumbUrlCandidates(avatar) {
        const urls = [];
        const cleanName = String(avatar || '').replace(/^[\/\\]+/, '');
        const encoded = encodeURIComponent(cleanName);

        const context = contextApi();
        if (context && typeof context.getThumbnailUrl === 'function') {
            try {
                const url = context.getThumbnailUrl('avatar', cleanName);
                if (typeof url === 'string' && url) urls.push(url);
            } catch (error) { /* 换下一个 */ }
        }

        try {
            urls.push('/thumbnail?type=avatar&file=' + encoded);
            urls.push('/thumbnail?type=avatar&avatar=' + encoded);
            urls.push('/thumbnail?type=avatar&file_name=' + encoded);
            urls.push('/thumbnail?type=avatar&name=' + encoded);
            urls.push('/get_thumbnail?type=avatar&file=' + encoded);
        } catch (error) {}
        try {
            urls.push('/characters/' + encoded);
            urls.push('characters/' + encoded);
            if (cleanName !== encoded) {
                urls.push('/characters/' + cleanName);
                urls.push('characters/' + cleanName);
            }
        } catch (error) {}

        return urls;
    }

    /** 从酒馆网页已渲染的 DOM 树中寻找该角色的头像 img 节点（直接读取已解压纹理，0 开销） */
    function findDomThumb(avatar) {
        if (typeof document === 'undefined') return '';
        try {
            const cleanName = String(avatar || '').replace(/^[\/\\]+/, '');
            const encoded = encodeURIComponent(cleanName);
            const imgs = document.querySelectorAll('img');
            for (let i = 0; i < imgs.length; i++) {
                const img = imgs[i];
                const src = img.currentSrc || img.src || img.getAttribute('src') || '';
                if (!src) continue;
                if (src.includes(cleanName) || (encoded && src.includes(encoded))) {
                    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                        const thumb = shrinkToThumb(img);
                        if (thumb) return thumb;
                    }
                }
            }
            const items = document.querySelectorAll('.character_select, .character_item, [data-avatar], [avatar]');
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const attr = item.getAttribute('data-avatar') || item.getAttribute('avatar') || '';
                if (attr && (attr === avatar || attr === cleanName || attr.includes(cleanName))) {
                    const img = item.querySelector('img');
                    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
                        const thumb = shrinkToThumb(img);
                        if (thumb) return thumb;
                    }
                }
            }
        } catch (e) {}
        return '';
    }

    /** 把图片对象缩放到不超过 112px，压成 JPEG base64（不带 data: 前缀）；支持跨域与防污处理 */
    function shrinkToThumb(image) {
        try {
            const width = image.naturalWidth || image.width || 0;
            const height = image.naturalHeight || image.height || 0;
            if (!width || !height) return '';
            const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(width, height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const context = canvas.getContext('2d');
            if (!context) return '';
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', THUMB_QUALITY);
            const comma = dataUrl.indexOf(',');
            if (comma < 0) return '';
            const base64 = dataUrl.slice(comma + 1);
            return base64.length > THUMB_MAX_CHARS ? '' : base64;
        } catch (error) {
            // 画布被跨域玷污或不支持时返回空，交由二进制/Blob 模式处理
            return '';
        }
    }

    /** 把下载到的原始卡片/图片二进制转为 112px JPEG base64；Blob URL 永不污染 Canvas */
    function renderBytesToThumb(bytes) {
        return new Promise(function (resolve) {
            if (!bytes || bytes.length < 8) return resolve('');
            let blobUrl = '';
            try {
                let mime = 'image/png';
                if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = 'image/jpeg';
                else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = 'image/webp';
                const blob = new Blob([bytes], { type: mime });
                blobUrl = URL.createObjectURL(blob);
                const image = new Image();
                let settled = false;
                const timer = setTimeout(function () {
                    if (settled) return;
                    settled = true;
                    if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                    resolve('');
                }, 4000);
                image.onload = function () {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try {
                        const thumb = shrinkToThumb(image);
                        if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                        resolve(thumb);
                    } catch (err) {
                        if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                        resolve('');
                    }
                };
                image.onerror = function () {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                    resolve('');
                };
                image.src = blobUrl;
            } catch (err) {
                if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                resolve('');
            }
        });
    }

    /**
     * 极速且绝对可靠的头像提取引擎：
     * 1) 优先命中内存缩略图缓存；
     * 2) 探测酒馆前端当前 DOM 树上已经加载好的角标头像；
     * 3) 携带 CSRF 与鉴权头尝试通过酒馆各候选静态地址 fetch，并用 Local Blob 转换为小头像（杜绝跨域污染 Canvas）；
     * 4) 终极兜底：直接调 exportCard(avatar)（酒馆官方导出接口，100% 可用），抽取卡图并转小头像；
     * 5) 返回 base64 JPEG（不带 data: 前缀）。
     */
    /**
     * 取一张小头像；返回 {data, reason}，reason 用来告诉 MIU 为什么没成。
     * 顺序：内存缓存 -> 酒馆页面上已渲染的头像 <img>（0 开销）-> 9 个候选地址
     * -> 下载字节用 Blob URL 转 canvas（画布不会被跨域污染）-> 兜底导出整卡抽图。
     */
    async function renderThumb(avatar) {
        if (!avatar || typeof avatar !== 'string') return { data: '', reason: 'thumb_bad_avatar' };
        const cached = THUMB_CACHE.get(avatar);
        if (typeof cached === 'string' && cached) return { data: cached, reason: '' };

        const deadline = Date.now() + THUMB_TOTAL_MS;

        // 1. 酒馆页面上已经渲染好的那张头像
        try {
            const domThumb = findDomThumb(avatar);
            if (domThumb) {
                THUMB_CACHE.set(avatar, domThumb);
                return { data: domThumb, reason: '' };
            }
        } catch (ignore) { /* 探测失败就往下走 */ }

        // 2. 候选地址逐个试
        const candidates = thumbUrlCandidates(avatar);
        let reason = candidates.length === 0 ? 'thumb_no_url' : 'thumb_fetch_failed';
        for (let index = 0; index < candidates.length; index++) {
            const left = deadline - Date.now();
            if (left <= 400) { reason = 'thumb_timeout'; break; }
            const url = candidates[index];
            try {
                const controller = new AbortController();
                const timer = setTimeout(function () { controller.abort(); }, Math.min(2500, Math.max(500, left)));
                const response = await fetch(url, {
                    headers: await requestHeaders(),
                    cache: 'no-store',
                    signal: controller.signal,
                }).finally(function () { clearTimeout(timer); });
                if (response.ok) {
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    if (bytes.length >= 8) {
                        const thumb = await renderBytesToThumb(bytes);
                        if (thumb) {
                            THUMB_CACHE.set(avatar, thumb);
                            return { data: thumb, reason: '' };
                        }
                        reason = 'thumb_render_failed';
                    }
                }
            } catch (error) {
                reason = (error && error.message) ? error.message : 'thumb_fetch_failed';
            }
        }

        // 3. 兜底：导出整卡 PNG，再从卡图里抽头像
        if (deadline - Date.now() > 500) {
            try {
                const cardBytes = await exportCard(avatar);
                if (cardBytes && cardBytes.length >= 8) {
                    const thumb = await renderBytesToThumb(cardBytes);
                    if (thumb) {
                        THUMB_CACHE.set(avatar, thumb);
                        return { data: thumb, reason: '' };
                    }
                }
                reason = 'thumb_export_unreadable';
            } catch (exportErr) {
                reason = 'thumb_export_failed';
            }
        }

        return { data: '', reason: reason };
    }

    // ------------------------------------------------------------------
    // 接收 MIU 推送（MIU -> 酒馆）
    // ------------------------------------------------------------------

    /** 把一张卡的字节导入酒馆。 */
    async function importCardToTavern(name, bytes) {
        const headers = await requestHeaders();
        delete headers['Content-Type'];
        delete headers['content-type'];

        const isJson = /\.json$/i.test(name);
        const form = new FormData();
        form.append('avatar', new Blob([bytes], { type: isJson ? 'application/json' : 'image/png' }), name);
        form.append('file_type', isJson ? 'json' : 'png');

        const response = await fetch('/api/characters/import', {
            method: 'POST',
            headers,
            body: form,
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('import_failed');
        return true;
    }

    /**
     * 队列里的字节是不是一本世界书；是就返回「摊平后」的 JSON 文本（顶层一定是 entries），不是就返回 null。
     * 角色卡一定带 spec / data 信封，且带 first_mes / personality 这类卡字段，靠这个区分。
     * 老版 MIU 导出的世界书会把条目包在 character_book / data.character_book 里，这里一并认出来，
     * 免得被当成角色卡送给酒馆（那会被回一句 Character name is missing）。
     */
    function worldbookPayload(bytes) {
        let parsed = null;
        try {
            parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch (ignore) {
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        if (looksLikeCharacterCard(parsed)) return null;

        const found = findWorldbookEntries(parsed, 0);
        if (!found) return null;

        const flat = Object.assign({}, parsed, found.owner === parsed ? {} : found.owner);
        delete flat.spec;
        delete flat.spec_version;
        delete flat.data;
        delete flat.character_book;
        delete flat.extensions;
        delete flat.world_info;
        delete flat.lorebook;
        flat.entries = found.entries;
        return JSON.stringify(flat, null, 2);
    }

    /** 在对象里递归找世界书的 entries（可能被包在 data / character_book / extensions 里，最多找 4 层）。 */
    function findWorldbookEntries(value, depth) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (depth > 4) return null;
        if (value.entries && typeof value.entries === 'object') {
            return { entries: value.entries, owner: value };
        }
        const containers = ['character_book', 'extensions', 'data'];
        for (let i = 0; i < containers.length; i++) {
            const hit = findWorldbookEntries(value[containers[i]], depth + 1);
            if (hit) return hit;
        }
        return null;
    }

    /** 把一本世界书导入酒馆的世界书目录（和角色卡走的接口不一样）。 */
    async function importWorldbookToTavern(name, payload) {
        const headers = await requestHeaders();
        delete headers['Content-Type'];
        delete headers['content-type'];

        const fileName = /\.json$/i.test(name) ? name : name + '.json';
        const form = new FormData();
        form.append('avatar', new Blob([payload], { type: 'application/json' }), fileName);

        const response = await fetch('/api/worldinfo/import', {
            method: 'POST',
            headers,
            body: form,
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('worldbook_import_failed');
        return true;
    }

    /** 角色卡的标志：spec 信封，或者卡字段（哪怕值是空字符串也算，用「有没有这个键」判断）。 */
    function looksLikeCharacterCard(parsed) {
        const cardFields = ['spec', 'first_mes', 'mes_example', 'personality', 'scenario', 'system_prompt', 'post_history_instructions'];
        for (let i = 0; i < cardFields.length; i++) {
            if (Object.prototype.hasOwnProperty.call(parsed, cardFields[i])) return true;
            if (parsed.data && Object.prototype.hasOwnProperty.call(parsed.data, cardFields[i])) return true;
        }
        return false;
    }

    /** 队列里的字节属于哪一类数据；认不出来就返回 null（当角色卡处理）。 */
    /** 文件名里的类型提示：App 推工具数据时会写成 xxx.preset.json 这种，不用再靠猜。 */
    function hintFromFileName(fileName) {
        const match = /\.(worldbook|preset|theme|qr|regex|script)\.json$/i.exec(String(fileName || ''));
        return match ? match[1].toLowerCase() : null;
    }

    /** 队列里的字节属于哪一类数据：文件名带类型就按它来，不带再按内容猜；实在认不出就报 unknown。 */
    function sniffJsonPayload(bytes, hint) {
        if (hint === 'worldbook') {
            const book = worldbookPayload(bytes);
            return book ? { kind: 'worldbook', label: '世界书', payload: book } : null;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch (ignore) {
            return null;
        }
        if (!parsed || typeof parsed !== 'object') return null;

        if (hint === 'preset') {
            const picked = pickPresetPayload(parsed);
            const preset = picked
                ? picked.preset
                : (parsed.preset && typeof parsed.preset === 'object' && !Array.isArray(parsed.preset) ? parsed.preset : parsed);
            return {
                kind: 'preset',
                label: '预设',
                payload: { apiId: picked ? picked.apiId : guessPresetApiId(preset), preset: preset },
            };
        }
        if (hint === 'theme') {
            const theme = pickThemePayload(parsed)
                || (parsed.theme && typeof parsed.theme === 'object' && !Array.isArray(parsed.theme) ? parsed.theme : parsed);
            return { kind: 'theme', label: '美化', payload: theme };
        }
        if (hint === 'qr') {
            return { kind: 'qr', label: '快速回复', payload: pickQuickReplyList(parsed) || [] };
        }
        if (hint === 'regex') {
            const scripts = pickRegexScripts(parsed);
            return scripts ? { kind: 'regex', label: '正则', payload: scripts } : { kind: 'unsupported', label: '脚本' };
        }

        const book = worldbookPayload(bytes);
        if (book) return { kind: 'worldbook', label: '世界书', payload: book };
        if (looksLikeCharacterCard(parsed)) return null;

        if (isPlainJsScript(parsed)) return { kind: 'unsupported', label: '脚本' };

        const scripts = pickRegexScripts(parsed);
        if (scripts) return { kind: 'regex', label: '正则', payload: scripts };

        const preset = pickPresetPayload(parsed);
        if (preset) return { kind: 'preset', label: '预设', payload: preset };

        const theme = pickThemePayload(parsed);
        if (theme) return { kind: 'theme', label: '美化', payload: theme };

        const qrList = pickQuickReplyList(parsed);
        if (qrList) return { kind: 'qr', label: '快速回复', payload: qrList };

        return { kind: 'unknown', label: '' };
    }

    /** MIU 的「脚本」卡里也有普通 JS 脚本（酒馆助手那种），酒馆核心没有它的导入接口。 */
    /** MIU 的「脚本」卡里也有普通 JS 脚本（酒馆助手那种），酒馆核心没有它的导入接口。 */
    function isPlainJsScript(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const candidates = [value, value.data];
        for (let i = 0; i < candidates.length; i++) {
            const inner = candidates[i];
            if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
            if (inner.type !== 'script' && inner.type !== 'tool') continue;
            if (typeof inner.content === 'string' || typeof inner.script === 'string' || typeof inner.code === 'string') return true;
        }
        return false;
    }
    function isRegexScript(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value) &&
            (value.findRegex !== undefined || value.find_regex !== undefined ||
                value.replaceString !== undefined || value.replace_with !== undefined);
    }

    /** 从脚本数据里挑出酒馆正则；挑不到说明它只是普通 JS 脚本。 */
    function pickRegexScripts(value) {
        const containers = [value, value.regex, value.scripts, value.regex_scripts,
            value.data && value.data.regex, value.data && value.data.regex_scripts];
        for (let i = 0; i < containers.length; i++) {
            const item = containers[i];
            if (Array.isArray(item)) {
                const hits = item.filter(isRegexScript);
                if (hits.length > 0) return hits;
            } else if (isRegexScript(item)) {
                return [item];
            }
        }
        return null;
    }

    /** 预设按 apiId 分目录存，酒馆的保存接口必须带这个 apiId，这里按内容猜一个。 */
    function guessPresetApiId(preset) {
        if (Array.isArray(preset.prompts) && preset.prompts.length > 0) return 'openai';
        if (Array.isArray(preset.prompt_order)) return 'openai';
        if (typeof preset.temp === 'number' || typeof preset.rep_pen === 'number' || typeof preset.top_k === 'number') return 'textgenerationwebui';
        if (typeof preset.temperature === 'number' && typeof preset.max_length === 'number') return 'novel';
        if (preset.input_sequence !== undefined || preset.output_sequence !== undefined) return 'instruct';
        if (typeof preset.content === 'string') return 'sysprompt';
        return 'openai';
    }

    function pickPresetPayload(value) {
        const inner = value.preset && typeof value.preset === 'object' && !Array.isArray(value.preset) ? value.preset : value;
        const hasPrompts = Array.isArray(inner.prompts) && inner.prompts.length > 0;
        const hasOrder = Array.isArray(inner.prompt_order);
        const hasSampler = typeof inner.temp === 'number' || typeof inner.rep_pen === 'number' || typeof inner.top_k === 'number';
        const hasOpenAiSampler = typeof inner.temperature === 'number' && typeof inner.top_p === 'number' && typeof inner.openai_max_tokens === 'number';
        if (!hasPrompts && !hasOrder && !hasSampler && !hasOpenAiSampler) return null;
        return { apiId: guessPresetApiId(inner), preset: inner };
    }

    function pickThemePayload(value) {
        const inner = value.theme && typeof value.theme === 'object' && !Array.isArray(value.theme) ? value.theme : value;
        const hit = inner.blur_strength !== undefined || inner.main_text_color !== undefined ||
            inner.chat_display !== undefined || inner.theme_name !== undefined || inner.chat_width !== undefined;
        return hit ? inner : null;
    }

    function pickQuickReplyList(value) {
        if (Array.isArray(value)) {
            const first = value[0];
            return first && (first.label !== undefined || first.message !== undefined) ? value : null;
        }
        const inner = value.set && typeof value.set === 'object' && !Array.isArray(value.set) ? value.set : value;
        if (Array.isArray(inner.qrList)) return inner.qrList;
        if (Array.isArray(value.quick_replies)) return value.quick_replies;
        if (inner.label !== undefined || inner.message !== undefined) return [inner];
        return null;
    }

    function stripExtension(name) {
        const value = String(name || '').trim();
        const stripped = value
            .replace(/\.(worldbook|preset|theme|qr|regex|script)\.json$/i, '')
            .replace(/\.[^./\\]+$/, '');
        return stripped || value || 'miu_tool';
    }
    async function postJsonToTavern(path, payload, errorCode) {
        const headers = await requestHeaders();
        headers['Content-Type'] = 'application/json';
        const response = await fetch(path, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(errorCode || 'import_failed');
        return true;
    }

    async function importPresetToTavern(fileName, info) {
        return postJsonToTavern('/api/presets/save', {
            name: stripExtension(fileName),
            apiId: info.apiId,
            preset: info.preset,
        }, 'preset_import_failed');
    }

    async function importThemeToTavern(fileName, theme) {
        return postJsonToTavern('/api/themes/save', Object.assign({}, theme, { name: stripExtension(fileName) }), 'theme_import_failed');
    }

    async function importQuickReplyToTavern(fileName, list) {
        return postJsonToTavern('/api/quick-replies/save', {
            version: 2,
            name: stripExtension(fileName),
            disableSend: false,
            placeBeforeInput: false,
            injectInput: false,
            color: 'transparent',
            onlyBorderColor: false,
            idIndex: list.length,
            qrList: list,
        }, 'qr_import_failed');
    }

    /**
     * 正则：酒馆没有单条导入的接口，只能在酒馆页面里直接改 extension_settings.regex 再触发保存，
     * 所以这条路只在 TT（或本机酒馆）里有效。
     */
    async function importRegexToTavern(fileName, scripts) {
        const module = await import('../../../extensions.js');
        const settings = module.extension_settings;
        if (!settings || typeof settings !== 'object') throw new Error('regex_import_failed');
        const current = Array.isArray(settings.regex) ? settings.regex.slice() : [];
        const keyOf = (script) => String((script && (script.id || script.findRegex || script.find_regex)) || '').trim();
        for (const script of scripts) {
            const key = keyOf(script);
            const index = key ? current.findIndex((item) => keyOf(item) === key) : -1;
            if (index >= 0) current[index] = script;
            else current.push(script);
        }
        settings.regex = current;
        await saveSettings();
        return true;
    }
    /** 分片取回 MIU 里的一张待发送卡。 */
    async function fetchOutboxCard(meta, label) {
        const total = Math.max(1, Math.ceil(Number(meta.bytes) / CHUNK_BYTES));
        const parts = [];
        for (let index = 0; index < total; index++) {
            const chunk = await callTool('miu_outbox_fetch', { id: meta.id, index });
            if (!chunk || typeof chunk.data !== 'string') throw new Error('bridge_bad_response');
            parts.push(base64ToBytes(chunk.data));
            if (total > 1) setStatus('正在接收 ' + label + '：' + (index + 1) + ' / ' + total + ' 片');
        }

        const bytes = new Uint8Array(Number(meta.bytes) || 0);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
        }
        if (offset !== bytes.length) throw new Error('bridge_bad_response');
        return bytes;
    }

    async function refreshTavernCharacters() {
        try {
            const context = contextApi();
            if (context && typeof context.getCharacters === 'function') {
                await context.getCharacters();
                return;
            }
        } catch (error) { /* 换 script.js 再试 */ }
        try {
            const module = await import('../../../../script.js');
            if (typeof module.getCharacters === 'function') await module.getCharacters();
        } catch (error) { /* 刷不出列表不影响导入本身 */ }
    }

    /** 把 MIU 里排队的卡全部导入酒馆；导入成功才 ack，失败的原样留在 MIU。 */
    async function receiveFromMiu() {
        await ensureConnected();
        const list = await callTool('miu_outbox_list', {});
        const cards = Array.isArray(list.cards) ? list.cards : [];
        if (cards.length === 0) {
            setStatus('MIU 里没有等待发送到酒馆的内容。', 'ok');
            log('待发送列表是空的。');
            return;
        }

        let done = 0;
        let failed = 0;
        for (let index = 0; index < cards.length; index++) {
            const meta = cards[index];
            const fileName = cardFileName(meta.name);
            try {
                const bytes = await fetchOutboxCard(meta, '「' + fileName + '」');
                const hint = /\.json$/i.test(fileName) ? hintFromFileName(fileName) : null;
                const kind = /\.json$/i.test(fileName) ? sniffJsonPayload(bytes, hint) : null;
                if (kind && kind.kind === 'worldbook') await importWorldbookToTavern(fileName, kind.payload);
                else if (kind && kind.kind === 'preset') await importPresetToTavern(fileName, kind.payload);
                else if (kind && kind.kind === 'theme') await importThemeToTavern(fileName, kind.payload);
                else if (kind && kind.kind === 'qr') await importQuickReplyToTavern(fileName, kind.payload);
                else if (kind && kind.kind === 'regex') await importRegexToTavern(fileName, kind.payload);
                else if (kind && kind.kind === 'unsupported') throw new Error('unsupported_script');
                else if (kind && kind.kind === 'unknown') throw new Error('unknown_json');
                else await importCardToTavern(fileName, bytes);
                await callTool('miu_outbox_ack', { id: meta.id });
                done++;
                log('已导入酒馆：' + fileName + '（' + (kind ? kind.label + '，' : '') + bytes.length + ' 字节）');
            } catch (error) {
                failed++;
                log('导入失败：' + fileName + '（' + describe(error) + '）');
            }
            updateReceiveLabel(Math.max(0, cards.length - index - 1));
            setStatus('接收中… 已导入 ' + done + ' / ' + cards.length + ' 项');
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        await refreshTavernCharacters();
        await refreshStatus();
        if (failed > 0) {
            setStatus('接收结束：成功 ' + done + ' 项，失败 ' + failed + ' 项（失败的那些还留在 MIU 队列里）。', 'error');
        } else {
            setStatus('接收结束：' + done + ' 项已导入酒馆。', 'ok');
        }
        log('本轮接收完成。');
    }

    const RECEIVE_LABEL = '接收 MIU 推送';
    let outboxTimer = null;

    // ------------------------------------------------------------------
    // MIU 主动拉取（MIU 里挑酒馆的卡）
    // ------------------------------------------------------------------

    /** 把（可能的）一部分目录记进内存：跨分类勾选时还能按 id 找回名字。 */
    function rememberCatalog(items) {
        const byId = new Map((state.catalog || []).map(item => [item.id, item]));
        (items || []).forEach(item => byId.set(item.id, item));
        state.catalog = Array.from(byId.values());
    }

    /**
     * MIU 要列表：MIU 点哪一类就只取哪一类（点角色卡不碰设置接口，点工具才读设置目录）。
     * 老版本 MIU 不带分类，这里就当「全都要」，行为跟以前一样。
     */
    async function sendCatalogToMiu(kind) {
        const want = PULL_KINDS.indexOf(String(kind || '')) >= 0 ? String(kind) : '';
        try {
            let list = [];
            if (!want || want === 'character') list = await listCharacters();
            let tools = [];
            if (!want || want !== 'character') {
                try {
                    tools = await loadToolCatalog(false);
                } catch (error) {
                    log('工具目录读取失败（角色卡不受影响）：' + describe(error));
                }
                if (want) tools = tools.filter(item => item.kind === want);
            }
            const merged = list.concat(tools);
            rememberCatalog(merged);
            await callTool('miu_pull_list', { json: JSON.stringify(merged) });
            const label = PULL_KIND_LABEL[want] || '';
            setStatus('已把酒馆里的 ' + merged.length + ' 项' + (label ? '（' + label + '）' : '') + '发给 MIU，去 MIU 里勾选。', 'ok');
            log('已把 ' + list.length + ' 张角色卡和 ' + tools.length + ' 项工具发给 MIU。');
        } catch (error) {
            const reason = describe(error);
            log('读取拉取列表失败：' + reason);
            try { await callTool('miu_pull_error', { message: reason }); } catch (ignore) { /* 报不上去也只是少条提示 */ }
        }
    }

    function kindFromId(id) {
        const prefix = String(id || '').split(':')[0];
        if (prefix === 'wb') return 'worldbook';
        if (prefix === 'preset') return 'preset';
        if (prefix === 'theme') return 'theme';
        if (prefix === 'qr') return 'qr';
        if (prefix === 'regex') return 'regex';
        return 'character';
    }

    /** MIU 勾好之后：角色卡导出 PNG，工具导出 JSON，推进待接收队列后回报新 id。 */
    async function pullForMiu(picks) {
        const named = new Map((state.catalog || []).map(item => [item.id, item]));
        const ids = [];
        let done = 0;
        let failed = 0;

        for (let index = 0; index < picks.length; index++) {
            const id = picks[index];
            const info = named.get(id);
            const kind = (info && info.kind) || kindFromId(id);
            let name = '';
            try {
                let result = null;
                if (kind === 'character') {
                    const avatar = (info && info.avatar) || id;
                    name = cardFileName((info && info.name) || avatar);
                    result = await pushOne({ avatar: avatar, name: name }, '「' + name + '」');
                } else {
                    const plainName = (info && info.name) || toolNameFromId(id) || kind;
                    name = toolFileName(plainName, kind);
                    const payload = await resolveToolPayload(id, info);
                    if (!payload) throw new Error('unknown_card');
                    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
                    if (bytes.length > MAX_CARD_BYTES) throw new Error('size_limit');
                    result = await pushBytes(name, bytes, '');
                }
                if (result && typeof result.id === 'string' && result.id) ids.push(result.id);
                done++;
                log('已拉到 MIU：' + name);
            } catch (error) {
                failed++;
                log('拉取失败：' + (name || id) + '（' + describe(error) + '）');
            }

            setStatus('正在给 MIU 拉取… ' + (index + 1) + ' / ' + picks.length);
            try {
                await callTool('miu_pull_report', { done: done, failed: failed, total: picks.length, final: false });
            } catch (error) { /* 进度报不上去不影响继续拉 */ }
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        try {
            await callTool('miu_pull_report', {
                done: done,
                failed: failed,
                total: picks.length,
                final: true,
                ids: ids,
                message: failed > 0
                    ? ('拉了 ' + done + ' 项，失败 ' + failed + ' 项。')
                    : ('已把 ' + done + ' 项拉到 MIU。'),
            });
        } catch (error) {
            log('回报拉取结果失败：' + describe(error));
        }

        if (failed > 0) {
            setStatus('拉取结束：成功 ' + done + ' 项，失败 ' + failed + ' 项（失败的那些 MIU 里没有）。', 'error');
        } else {
            setStatus('拉取结束：' + done + ' 项已送进 MIU，切回 MIU 会自动入库。', 'ok');
        }
    }

    /** 轮询里顺手处理 MIU 的拉取请求；有活干就返回 true。 */
    async function handlePullRequests() {
        const task = await callTool('miu_pull_state', {});
        if (task && task.listWanted) {
            await sendCatalogToMiu(task.wantKind);
            return true;
        }
        const picks = (task && Array.isArray(task.picks)) ? task.picks : [];
        if (picks.length > 0) {
            await pullForMiu(picks);
            return true;
        }
        const wanted = (task && Array.isArray(task.thumbWanted)) ? task.thumbWanted : [];
        if (wanted.length > 0) {
            await sendThumbsToMiu(wanted);
            return true;
        }
        return false;
    }

    /** MIU 要列表里那几张卡的头像：渲染成小图送过去（一轮最多 THUMB_PER_ROUND 张）。 */
    async function sendThumbsToMiu(avatars) {
        const items = [];
        let firstReason = '';
        for (let index = 0; index < avatars.length && items.length < THUMB_PER_ROUND; index++) {
            const avatar = avatars[index];
            if (typeof avatar !== 'string' || !avatar) continue;
            let result = { data: '', reason: 'thumb_error' };
            try {
                result = await renderThumb(avatar);
            } catch (error) {
                result = { data: '', reason: 'thumb_error' };
            }
            if (!result.data && !firstReason) firstReason = result.reason || 'thumb_unknown';
            // 渲染不出来也回报一声（带原因），MIU 那边就不会反复要同一张
            items.push({ avatar: avatar, data: result.data, reason: result.reason || '' });
        }
        if (items.length === 0) return;
        const ok = items.filter(item => item.data).length;
        if (ok === 0) log('小头像：这 ' + items.length + ' 张都没渲染出来（原因：' + (firstReason || 'thumb_unknown') + '）。');
        try {
            await callTool('miu_thumb_data', { json: JSON.stringify(items) });
        } catch (error) {
            log('小头像发送失败：' + describe(error));
        }
    }

    function updateReceiveLabel(count) {
        const button = document.getElementById('miu_bridge_receive');
        if (!button) return;
        button.textContent = count > 0 ? (RECEIVE_LABEL + ' (' + count + ')') : RECEIVE_LABEL;
    }

    async function pollOnce() {
        if (!state.connected || !state.registrationId || state.busy || state.pullBusy) return;
        try {
            const list = await callTool('miu_outbox_list', {});
            updateReceiveLabel(Number(list.count) || 0);
        } catch (error) { /* 轮询失败不打扰用户 */ }

        if (!state.connected || !state.registrationId || state.busy || state.pullBusy) return;
        state.pullBusy = true;
        try {
            await handlePullRequests();
        } catch (error) {
            log('处理 MIU 的拉取请求失败：' + describe(error));
        } finally {
            state.pullBusy = false;
        }
    }

    function startOutboxPolling() {
        if (outboxTimer) return;
        outboxTimer = setInterval(pollOnce, 3000);
        // 酒馆在后台时定时器会被系统降频甚至停摆，回到前台的瞬间补一次，MIU 那边就不用干等。
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') pollOnce();
        });
    }

    // ------------------------------------------------------------------
    // 按钮
    // ------------------------------------------------------------------

    async function withBusy(task) {
        if (state.busy) return;
        state.busy = true;
        try {
            await task();
        } catch (error) {
            state.connected = state.connected && Boolean(state.registrationId);
            setStatus(describe(error), 'error');
            log(describe(error));
        } finally {
            state.busy = false;
        }
    }

    function bindUi() {
        const connectButton = document.getElementById('miu_bridge_connect');
        const pushCurrentButton = document.getElementById('miu_bridge_push_current');
        const pushAllButton = document.getElementById('miu_bridge_push_all');
        const pendingButton = document.getElementById('miu_bridge_pending');
        const receiveButton = document.getElementById('miu_bridge_receive');

        connectButton.addEventListener('click', function () {
            withBusy(async function () {
                setStatus('正在连接 MIU…');
                log('开始连接，依次尝试端口 ' + orderedPorts().join('、') + '。');
                const info = await connect();
                log('连接成功：端口 ' + info.port + '（扩展 ' + BUILD_TAG + '）。');
                await refreshStatus();
            });
        });

        pushCurrentButton.addEventListener('click', function () {
            withBusy(async function () {
                await ensureConnected();
                const character = currentCharacter();
                if (!character) throw new Error('select_character');
                setStatus('正在推送「' + character.name + '」…');
                const result = await pushOne(character, '「' + character.name + '」');
                log('已推送：' + result.name + '（' + result.bytes + ' 字节）。');
                await refreshStatus();
                setStatus('已推送到 MIU：' + result.name + '。现在切回 MIU 点「导入待接收卡片」。', 'ok');
            });
        });

        pushAllButton.addEventListener('click', function () {
            withBusy(async function () {
                await ensureConnected();
                const characters = await listCharacters();
                if (characters.length === 0) {
                    setStatus('TT 里没有可推送的角色卡。', 'error');
                    return;
                }
                if (!window.confirm('把 TT 里的 ' + characters.length + ' 张角色卡全部推送到 MIU？')) {
                    setStatus('已取消。');
                    return;
                }

                let done = 0;
                let failed = 0;
                let pending = 0;
                for (let index = 0; index < characters.length; index++) {
                    const character = characters[index];
                    try {
                        const result = await pushOne(character, '第 ' + (index + 1) + ' 张');
                        if (result && typeof result.pending === 'number') pending = result.pending;
                        done++;
                    } catch (error) {
                        failed++;
                        log('推送失败：' + character.name + '（' + describe(error) + '）');
                    }
                    setStatus('推送中… 已推 ' + done + '/' + characters.length + ' 张（MIU 待接收 ' + pending + ' 张）');
                    await new Promise(resolve => setTimeout(resolve, 0));
                }

                if (failed > 0) {
                    setStatus('推送结束：成功 ' + done + ' 张，失败 ' + failed + ' 张。切回 MIU 点「导入待接收卡片」。', 'error');
                } else {
                    setStatus('推送结束：' + done + ' 张已送达 MIU。切回 MIU 点「导入待接收卡片」即可入库。', 'ok');
                }
                log('本轮推送完成。');
            });
        });

        pendingButton.addEventListener('click', function () {
            withBusy(async function () {
                await ensureConnected();
                const info = await callTool('miu_list_pending', {});
                const names = (info.cards || []).map(card => card.name).slice(0, 5).join('、');
                await refreshStatus();
                log('MIU 待接收 ' + info.pending + ' 张：' + (names || '（空）'));
            });
        });

        receiveButton.addEventListener('click', function () {
            withBusy(async function () {
                await receiveFromMiu();
            });
        });
    }

    function mount() {
        const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!container) {
            console.warn('[MIU 联动] 没找到扩展设置容器，面板未挂载。');
            return false;
        }
        container.insertAdjacentHTML('beforeend', buildHtml());
        bindUi();
        updateReceiveLabel(0);
        startOutboxPolling();
        console.log('[MIU 联动] 面板已挂载。');
        return true;
    }

    function whenContainer() {
        if (mount()) return;
        let tries = 0;
        const timer = setInterval(function () {
            tries++;
            if (mount() || tries > 60) clearInterval(timer);
        }, 500);
    }

    function onReady(callback) {
        if (typeof window.jQuery === 'function') {
            window.jQuery(callback);
            return;
        }
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(callback, 0);
            return;
        }
        document.addEventListener('DOMContentLoaded', callback, { once: true });
    }

    onReady(whenContainer);
})();
