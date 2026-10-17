/**
 * MIU 推卡桥接（MIU Card Bridge）
 * ------------------------------------------------------------------
 * 作用：把酒馆（TauriTavern / SillyTavern）里的角色卡，通过手机本机的
 *       回环端口（127.0.0.1）直接推送给 MIU 安卓 App。
 *
 * 特点：不登录账号、不上传云端，数据只在你这台手机里走。
 *
 * 使用前提：MIU 安卓 App 里「设置 -> TT 互联 -> 开启接收服务」已经打开。
 */

(function () {
    'use strict';

    const MODULE_NAME = 'miuBridge';
    const CANDIDATE_PORTS = [8791, 8792, 8793, 8794, 8795];
    /** 每次请求带几张卡，避免单次请求体过大 */
    const BATCH_SIZE = 8;

    let isPushing = false;

    // ------------------------------------------------------------------
    // 上下文 / 设置
    // ------------------------------------------------------------------

    function getContext() {
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
        } catch (e) {
            // 忽略
        }
        return null;
    }

    function getSettings() {
        const context = getContext();
        if (!context || !context.extensionSettings) {
            return { port: CANDIDATE_PORTS[0] };
        }
        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = { port: CANDIDATE_PORTS[0] };
        }
        return context.extensionSettings[MODULE_NAME];
    }

    function saveSettings() {
        const context = getContext();
        if (context && typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        }
    }

    // ------------------------------------------------------------------
    // 界面
    // ------------------------------------------------------------------

    function setStatus(text, kind) {
        const el = document.getElementById('miu_bridge_status');
        if (!el) return;
        el.textContent = text;
        el.classList.remove('miu-ok', 'miu-error');
        if (kind === 'ok') el.classList.add('miu-ok');
        if (kind === 'error') el.classList.add('miu-error');
    }

    function logLine(text) {
        const box = document.getElementById('miu_bridge_log');
        if (!box) return;
        const time = new Date().toLocaleTimeString();
        box.textContent = '[' + time + '] ' + text + '\n' + box.textContent;
        if (box.textContent.length > 8000) {
            box.textContent = box.textContent.slice(0, 8000);
        }
    }

    function buildHtml() {
        return '' +
            '<div class="miu-bridge-block">' +
            '  <div class="miu-bridge-status" id="miu_bridge_status">正在检测 MIU 接收服务…</div>' +
            '  <div class="miu-bridge-row">' +
            '    <label for="miu_bridge_port">端口</label>' +
            '    <input id="miu_bridge_port" class="text_pole miu-bridge-port" type="text" inputmode="numeric" value="8791" />' +
            '    <div class="menu_button" id="miu_bridge_probe">检测连接</div>' +
            '    <div class="menu_button" id="miu_bridge_push_all">推送全部角色卡</div>' +
            '    <div class="menu_button" id="miu_bridge_push_current">推送当前角色</div>' +
            '  </div>' +
            '  <div class="miu-bridge-log" id="miu_bridge_log"></div>' +
            '</div>';
    }

    // ------------------------------------------------------------------
    // 与 MIU 通信
    // ------------------------------------------------------------------

    function baseUrl(port) {
        return 'http://127.0.0.1:' + port;
    }

    async function probePort(port) {
        try {
            const res = await fetch(baseUrl(port) + '/ping', { method: 'GET', cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            if (data && data.ok) return data;
        } catch (e) {
            // 端口没开就是连接失败，正常
        }
        return null;
    }

    /** 依次探测候选端口，返回 {'port': 8791, 'info': {...}} 或 null */
    async function findReceiver() {
        const settings = getSettings();
        const ports = [];
        const preferred = Number(settings.port);
        if (preferred > 0) ports.push(preferred);
        for (let i = 0; i < CANDIDATE_PORTS.length; i++) {
            if (ports.indexOf(CANDIDATE_PORTS[i]) < 0) ports.push(CANDIDATE_PORTS[i]);
        }

        for (let i = 0; i < ports.length; i++) {
            const info = await probePort(ports[i]);
            if (info) {
                if (Number(settings.port) !== ports[i]) {
                    settings.port = ports[i];
                    saveSettings();
                    const input = document.getElementById('miu_bridge_port');
                    if (input) input.value = String(ports[i]);
                }
                return { port: ports[i], info: info };
            }
        }
        return null;
    }

    /** 取角色卡的原始 PNG 字节 */
    async function fetchCharacterPng(avatar) {
        const encoded = encodeURIComponent(avatar);
        const candidates = [
            '/characters/' + encoded,
            '/api/characters/download?avatar=' + encoded,
            '/api/characters/' + encoded,
        ];

        for (let i = 0; i < candidates.length; i++) {
            try {
                const res = await fetch(candidates[i]);
                if (!res.ok) continue;
                const blob = await res.blob();
                if (blob && blob.size > 200) return blob;
            } catch (e) {
                // 换下一个接口
            }
        }
        return null;
    }

    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () {
                const result = String(reader.result || '');
                const comma = result.indexOf(',');
                resolve(comma >= 0 ? result.slice(comma + 1) : '');
            };
            reader.onerror = function () {
                reject(reader.error || new Error('读取卡片失败'));
            };
            reader.readAsDataURL(blob);
        });
    }

    function safeName(rawName) {
        let name = String(rawName || '').trim().replace(/[\\/]/g, '_');
        if (!name) name = 'miu_' + Date.now();
        if (!/\.(png|jpe?g|webp|json)$/i.test(name)) name += '.png';
        return name;
    }

    async function pushBatch(port, batch) {
        const res = await fetch(baseUrl(port) + '/push', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ cards: batch }),
        });
        if (!res.ok) {
            throw new Error('MIU 返回了 ' + res.status);
        }
        return await res.json();
    }

    // ------------------------------------------------------------------
    // 主流程
    // ------------------------------------------------------------------

    async function pushCharacters(characters, label) {
        if (isPushing) {
            logLine('上一次推送还没结束，请稍等。');
            return;
        }

        if (!characters || characters.length === 0) {
            setStatus('没有可推送的角色卡。', 'error');
            return;
        }

        const input = document.getElementById('miu_bridge_port');
        const settings = getSettings();
        if (input && input.value) {
            const typed = Number(input.value);
            if (typed > 0) settings.port = typed;
        }

        isPushing = true;
        setStatus('正在查找 MIU 接收服务…');

        try {
            const receiver = await findReceiver();
            if (!receiver) {
                setStatus('没找到 MIU 的接收服务。请先在 MIU 里打开「设置 → TT 互联 → 开启接收服务」，再回来重试。', 'error');
                logLine('探测 8791-8795 全部失败：没有服务在监听。');
                return;
            }

            logLine('已连接 MIU（端口 ' + receiver.port + '），开始推送 ' + label + '，共 ' + characters.length + ' 张…');

            let done = 0;
            let failed = [];
            let pending = receiver.info && typeof receiver.info.pending === 'number' ? receiver.info.pending : 0;

            for (let i = 0; i < characters.length; i += BATCH_SIZE) {
                const slice = characters.slice(i, i + BATCH_SIZE);
                const batch = [];

                for (let j = 0; j < slice.length; j++) {
                    const character = slice[j];
                    const avatar = character.avatar || character.avatar_url || '';
                    if (!avatar) {
                        failed.push(character.name || '(无名)');
                        continue;
                    }
                    try {
                        const blob = await fetchCharacterPng(avatar);
                        if (!blob) {
                            failed.push(character.name || avatar);
                            continue;
                        }
                        const data = await blobToBase64(blob);
                        batch.push({ name: safeName(character.name || avatar), data: data });
                    } catch (e) {
                        failed.push(character.name || avatar);
                    }
                }

                if (batch.length === 0) continue;

                try {
                    const result = await pushBatch(receiver.port, batch);
                    done += batch.length;
                    if (result && typeof result.pending === 'number') pending = result.pending;
                } catch (e) {
                    logLine('这一批推送失败：' + (e && e.message ? e.message : e));
                    for (let k = 0; k < batch.length; k++) failed.push(batch[k].name);
                }

                setStatus('推送中… 已推 ' + done + '/' + characters.length + ' 张（MIU 待接收 ' + pending + ' 张）');
                await new Promise(function (r) { setTimeout(r, 0); });
            }

            if (failed.length > 0) {
                setStatus('推送完成：成功 ' + done + ' 张，失败 ' + failed.length + ' 张。请回到 MIU 点「导入待接收卡片」。', 'error');
                logLine('失败：' + failed.join('、'));
            } else {
                setStatus('推送完成：' + done + ' 张已送达 MIU。现在切回 MIU，点「导入待接收卡片」即可入库。', 'ok');
            }
            logLine('本次推送结束。');
        } catch (e) {
            setStatus('推送出错：' + (e && e.message ? e.message : e), 'error');
            logLine('异常：' + (e && e.message ? e.message : e));
        } finally {
            isPushing = false;
        }
    }

    function getContextCharacters() {
        const context = getContext();
        if (!context || !Array.isArray(context.characters)) return [];
        return context.characters.filter(function (c) { return c && c.avatar; });
    }

    function getCurrentCharacter() {
        const context = getContext();
        if (!context || !Array.isArray(context.characters)) return null;
        const index = Number(context.characterId);
        if (!isFinite(index) || index < 0) return null;
        const character = context.characters[index];
        if (!character || !character.avatar) return null;
        return character;
    }

    // ------------------------------------------------------------------
    // 初始化
    // ------------------------------------------------------------------

    jQuery(async function () {
        const container = document.getElementById('extensions_settings');
        if (!container) {
            console.warn('[MIU Bridge] 没找到扩展设置容器，UI 未挂载。');
            return;
        }

        container.insertAdjacentHTML('beforeend', buildHtml());

        const settings = getSettings();
        const portInput = document.getElementById('miu_bridge_port');
        if (portInput) portInput.value = String(settings.port || CANDIDATE_PORTS[0]);

        document.getElementById('miu_bridge_probe').addEventListener('click', async function () {
            setStatus('正在检测…');
            const input = document.getElementById('miu_bridge_port');
            if (input && input.value) {
                const typed = Number(input.value);
                if (typed > 0) {
                    const settingsNow = getSettings();
                    settingsNow.port = typed;
                    saveSettings();
                }
            }
            const receiver = await findReceiver();
            if (receiver) {
                setStatus('已连接 MIU（端口 ' + receiver.port + '，当前待接收 ' +
                    (receiver.info && receiver.info.pending) + ' 张）。', 'ok');
                logLine('连接成功，端口 ' + receiver.port + '。');
            } else {
                setStatus('没找到 MIU 接收服务。请先在 MIU 里开启「设置 → TT 互联 → 开启接收服务」。', 'error');
                logLine('连接失败：8791-8795 没有服务。');
            }
        });

        document.getElementById('miu_bridge_push_all').addEventListener('click', function () {
            const characters = getContextCharacters();
            pushCharacters(characters, '全部角色卡');
        });

        document.getElementById('miu_bridge_push_current').addEventListener('click', function () {
            const character = getCurrentCharacter();
            if (!character) {
                setStatus('当前没有选中的角色。', 'error');
                return;
            }
            pushCharacters([character], '当前角色「' + (character.name || character.avatar) + '」');
        });

        // 打开面板时自动检测一次
        probePort(Number(settings.port) || CANDIDATE_PORTS[0]).then(function (info) {
            if (info) {
                setStatus('已连接 MIU（端口 ' + (Number(settings.port) || CANDIDATE_PORTS[0]) +
                    '，当前待接收 ' + info.pending + ' 张）。', 'ok');
            } else {
                setStatus('未连接。请先在 MIU 里开启「设置 → TT 互联 → 开启接收服务」，然后点「检测连接」。');
            }
        });

        console.log('[MIU Bridge] 扩展已加载。');
    });
})();