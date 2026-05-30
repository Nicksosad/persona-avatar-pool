/*
 * Persona Avatar Pool
 * -------------------------------------------------------------
 * 给每个 persona（用户人设）配置一个“头像库”。
 * 每次该 user 发言时，从该 persona 的头像库里随机抽取一张图片，
 * 作为「这一条消息」的头像（写入消息的原生 force_avatar 字段，可持久化）。
 *
 * - 仅改变聊天消息上显示的头像，不改变 persona 本身的头像
 * - 按 persona 绑定（key = 当前 persona 的头像文件名）
 * - 随机时避免与上一条连续重复
 * - 每条消息记住当时抽到的头像，重开聊天不变
 * - 库为空则使用原头像（不做任何处理）
 * - 提供总开关
 * - 图片通过酒馆原生 /api/avatars/upload 上传到 User Avatars 目录
 *
 * 纯前端扩展，不依赖任何其他插件。
 */

(function () {
    'use strict';

    const MODULE_NAME = 'persona-avatar-pool';
    const BTN_ID = 'pap_open_button';
    const POPUP_ID = 'pap_popup_overlay';

    // ---------------------------------------------------------
    // 工具：获取酒馆上下文
    // ---------------------------------------------------------
    function getCtx() {
        return window.SillyTavern && window.SillyTavern.getContext
            ? window.SillyTavern.getContext()
            : null;
    }

    // ---------------------------------------------------------
    // 设置（存在 extensionSettings 里，随酒馆设置持久化）
    // 结构：
    //   {
    //     enabled: true,
    //     pools: { "<personaKey>": ["fileA.png", "fileB.png", ...] }
    //   }
    // 注意：pools 里只存「文件名」，不存图片本体。
    // ---------------------------------------------------------
    function getSettings() {
        const ctx = getCtx();
        if (!ctx) return { enabled: true, pools: {} };

        const root = ctx.extensionSettings;
        if (!root[MODULE_NAME]) {
            root[MODULE_NAME] = { enabled: true, pools: {}, seeded: {} };
        }
        const s = root[MODULE_NAME];
        if (typeof s.enabled !== 'boolean') s.enabled = true;
        if (!s.pools || typeof s.pools !== 'object') s.pools = {};
        if (!s.seeded || typeof s.seeded !== 'object') s.seeded = {};
        return s;
    }

    function saveSettings() {
        const ctx = getCtx();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }

    // ---------------------------------------------------------
    // 解析「当前 persona」的 key（= 当前 persona 头像文件名）
    // 多重回退，因为不同酒馆版本暴露位置不同。
    // ---------------------------------------------------------
    function getCurrentPersonaKey() {
        const ctx = getCtx();

        // 1) DOM 上当前“选中态”的 persona —— 最贴近 UI 实际选择。
        //    切换 persona 时酒馆会给对应头像加上 .selected，
        //    其 imgfile / data-avatar-id 即头像文件名。
        const domKey = getSelectedPersonaKeyFromDom();
        if (domKey) return domKey;

        // 2) context 顶层实时值（部分版本会在切换时同步更新）
        if (ctx && typeof ctx.user_avatar === 'string' && ctx.user_avatar) {
            return ctx.user_avatar;
        }
        // 3) 全局 user_avatar（部分版本是局部变量，未必挂到 window；放后面）
        if (typeof window.user_avatar === 'string' && window.user_avatar) {
            return window.user_avatar;
        }
        // 4) power_user.default_persona（默认人设，仅作兜底）
        const pu = ctx && (ctx.powerUserSettings || window.power_user);
        if (pu && typeof pu.default_persona === 'string' && pu.default_persona) {
            return pu.default_persona;
        }
        // 5) personas 列表第一个
        if (pu && pu.personas && typeof pu.personas === 'object') {
            const keys = Object.keys(pu.personas);
            if (keys.length) return keys[0];
        }
        return 'user-default.png';
    }

    // 从 persona 管理面板的 DOM 里读“当前选中”的 persona 头像文件名。
    // 兼容不同酒馆版本的选中态标记与文件名属性。
    function getSelectedPersonaKeyFromDom() {
        // 选中的 persona 元素：不同版本可能是这些选择器之一
        const selectors = [
            '#user_avatar_block .avatar-container.selected',
            '#user_avatar_block .avatar.selected',
            '#user_avatar_block .selected[imgfile]',
            '#user_avatar_block .selected',
        ];
        let el = null;
        for (const sel of selectors) {
            el = document.querySelector(sel);
            if (el) break;
        }
        if (!el) return null;

        // 文件名可能挂在自身或子元素的 imgfile / data-avatar-id 上
        const holder = el.matches('[imgfile],[data-avatar-id]')
            ? el
            : el.querySelector('[imgfile],[data-avatar-id]');
        if (!holder) return null;

        const file = holder.getAttribute('imgfile')
            || holder.getAttribute('data-avatar-id');
        return file && file.trim() ? file.trim() : null;
    }

    function getPersonaDisplayName(key) {
        const ctx = getCtx();
        const pu = ctx && (ctx.powerUserSettings || window.power_user);
        if (pu && pu.personas && pu.personas[key]) return pu.personas[key];
        return key;
    }

    // 返回当前 persona 的头像库数组（引用，可直接 push/splice 后 saveSettings）
    function getPool(personaKey) {
        const s = getSettings();
        if (!Array.isArray(s.pools[personaKey])) s.pools[personaKey] = [];
        return s.pools[personaKey];
    }

    // 确保 persona 自带的原头像默认在头像库里。
    // 只在首次（未 seed 过该 persona）时注入一次：之后用户若手动删掉原头像，
    // 不会每次打开又被强制加回。personaKey 本身就是原头像文件名。
    function ensureDefaultAvatar(personaKey) {
        if (!personaKey) return;
        const s = getSettings();
        if (s.seeded[personaKey]) return; // 已注入过，尊重用户后续删除
        const pool = getPool(personaKey);
        if (!pool.includes(personaKey)) {
            // 原头像放在最前面
            pool.unshift(personaKey);
        }
        s.seeded[personaKey] = true;
        saveSettings();
    }

    // ---------------------------------------------------------
    // 根据头像文件名生成 force_avatar 用的缩略图 URL
    // 与酒馆 user 消息原生 force_avatar 格式保持一致：
    //   /thumbnail?type=persona&file=<文件名>
    // ---------------------------------------------------------
    function fileToForceAvatar(fileName) {
        return `/thumbnail?type=persona&file=${encodeURIComponent(fileName)}`;
    }

    // 完整尺寸原图 URL（放大查看用）。User Avatars 目录下的原始文件，
    // 无缩略图压缩，画质最佳。
    function fileToFullImage(fileName) {
        return `/User Avatars/${encodeURIComponent(fileName)}`;
    }

    // 用于展示的名字：去掉文件名里的括号及其中内容（中文（）和英文()），
    // 只影响 UI 显示，不改变实际文件名/存储。
    function displayName(fileName) {
        return String(fileName)
            .replace(/（[^）]*）/g, '')  // 全角括号
            .replace(/\([^)]*\)/g, '')   // 半角括号
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ---------------------------------------------------------
    // 随机抽取一张，避免与上一条连续重复
    // ---------------------------------------------------------
    function pickRandom(pool, lastFile) {
        if (!pool.length) return null;
        if (pool.length === 1) return pool[0];
        let candidates = pool;
        if (lastFile && pool.includes(lastFile)) {
            candidates = pool.filter((f) => f !== lastFile);
            if (!candidates.length) candidates = pool;
        }
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // 记录每个 persona 上一次抽到的文件，用于“避免连续重复”
    const lastPicked = {};

    // ---------------------------------------------------------
    // 核心：给指定 index 的消息套用随机头像
    // ---------------------------------------------------------
    async function applyRandomAvatarToMessage(index) {
        const ctx = getCtx();
        if (!ctx) return;

        const s = getSettings();
        if (!s.enabled) return;

        const msg = ctx.chat && ctx.chat[index];
        if (!msg || !msg.is_user) return; // 只处理 user 消息

        const personaKey = getCurrentPersonaKey();
        const pool = getPool(personaKey);
        if (!pool.length) return; // 库为空 -> 用原头像，不动

        const chosen = pickRandom(pool, lastPicked[personaKey]);
        if (!chosen) return;
        lastPicked[personaKey] = chosen;

        // 写入原生 force_avatar，酒馆会自己渲染并随聊天保存
        msg.force_avatar = fileToForceAvatar(chosen);
        // 记录原始 persona，便于将来需要时还原
        if (!msg.original_avatar) msg.original_avatar = personaKey;

        // 立即刷新这条消息的 DOM 头像（避免等待重渲染）
        updateMessageAvatarDom(index, msg.force_avatar);

        if (typeof ctx.saveChat === 'function') {
            try { await ctx.saveChat(); } catch (e) { /* 忽略保存异常 */ }
        }
    }

    // 直接更新某条消息 DOM 上的头像 img.src
    function updateMessageAvatarDom(index, src) {
        const mesEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (!mesEl) return;
        const img = mesEl.querySelector('.mesAvatarWrapper .avatar img, .avatar img');
        if (img) img.src = src;
    }

    // ---------------------------------------------------------
    // 原生上传：把图片文件上传到 User Avatars 目录
    // 走 /api/avatars/upload （multipart/form-data，字段名 avatar）
    // 返回最终存储的文件名。
    // ---------------------------------------------------------
    async function uploadAvatarFile(file) {
        const ctx = getCtx();
        if (!ctx) throw new Error('SillyTavern context 不可用');

        const form = new FormData();
        form.append('avatar', file, file.name);

        // 关键：multipart 上传不要手动设置 Content-Type，
        // 让浏览器自动加 boundary。getRequestHeaders 支持 omitContentType。
        let headers = {};
        try {
            headers = ctx.getRequestHeaders
                ? ctx.getRequestHeaders({ omitContentType: true })
                : {};
        } catch (e) {
            headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : {};
        }
        // 保险起见，删掉可能存在的 Content-Type
        delete headers['Content-Type'];
        delete headers['content-type'];

        const resp = await fetch('/api/avatars/upload', {
            method: 'POST',
            headers,
            body: form,
        });

        if (!resp.ok) {
            throw new Error(`上传失败：${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json();
        // 后端返回 { path: filename }
        return data.path || data.filename || null;
    }

    // 原生删除 User Avatars 里的文件
    async function deleteAvatarFile(fileName) {
        const ctx = getCtx();
        if (!ctx) throw new Error('SillyTavern context 不可用');
        const resp = await fetch('/api/avatars/delete', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar: fileName }),
        });
        return resp.ok;
    }

    // ---------------------------------------------------------
    // 事件：user 发言时套用随机头像
    // ---------------------------------------------------------
    function bindEvents() {
        const ctx = getCtx();
        if (!ctx || !ctx.eventSource || !ctx.event_types) return;

        const { eventSource, event_types } = ctx;

        // MESSAGE_SENT：用户发送消息后触发，回调参数为消息 index
        if (event_types.MESSAGE_SENT) {
            eventSource.on(event_types.MESSAGE_SENT, (index) => {
                // index 可能是 number，也可能未传，做兼容
                let idx = index;
                if (typeof idx !== 'number') {
                    idx = (ctx.chat ? ctx.chat.length - 1 : -1);
                }
                if (idx >= 0) applyRandomAvatarToMessage(idx);
            });
        }
    }

    // ---------------------------------------------------------
    // UI：在 persona 控制区的 buttons_block 注入按钮
    // ---------------------------------------------------------
    function injectButton() {
        const block = document.querySelector('.persona_controls_buttons_block.buttons_block')
            || document.querySelector('.persona_controls_buttons_block')
            || document.querySelector('.buttons_block');
        if (!block) return false;
        if (document.getElementById(BTN_ID)) return true; // 已存在

        const btn = document.createElement('div');
        btn.id = BTN_ID;
        // 复用酒馆原生按钮样式
        btn.className = 'menu_button fa-solid fa-images interactable';
        btn.title = '头像库（随机头像）';
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('role', 'button');
        btn.addEventListener('click', openPopup);

        // 插到「复制人设」按钮之前 —— 即位于「更改人设图」与「复制人设」之间。
        // 取不到目标按钮时回退到追加到末尾。
        const dupBtn = block.querySelector('#persona_duplicate_button');
        if (dupBtn) {
            block.insertBefore(btn, dupBtn);
        } else {
            block.appendChild(btn);
        }
        return true;
    }

    // 持续确保按钮存在（persona 面板可能被酒馆重新渲染）
    function ensureButtonLoop() {
        injectButton();
        setInterval(injectButton, 2000);
    }

    // ---------------------------------------------------------
    // UI：管理弹窗
    // ---------------------------------------------------------
    function openPopup() {
        closePopup(); // 防重复

        const personaKey = getCurrentPersonaKey();
        const personaName = getPersonaDisplayName(personaKey);
        const s = getSettings();

        // 首次打开时，把 persona 自带的原头像默认放进库里
        ensureDefaultAvatar(personaKey);

        const overlay = document.createElement('div');
        overlay.id = POPUP_ID;
        overlay.className = 'pap-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closePopup();
        });

        const box = document.createElement('div');
        box.className = 'pap-box';

        box.innerHTML = `
            <div class="pap-header">
                <span class="pap-title">头像库 · ${escapeHtml(personaName)}</span>
                <span class="pap-close" title="关闭">&times;</span>
            </div>
            <div class="pap-toolbar">
                <label class="pap-switch">
                    <input type="checkbox" id="pap_enabled" ${s.enabled ? 'checked' : ''}>
                    <span>启用随机头像</span>
                </label>
                <button class="menu_button pap-add-btn" id="pap_add">添加图片</button>
                <input type="file" id="pap_file_input" accept="image/*" multiple style="display:none">
            </div>
            <div class="pap-hint">当前人设：<b>${escapeHtml(personaName)}</b>（${escapeHtml(personaKey)}）。库里有 <b id="pap_count">0</b> 张图片。</div>
            <div class="pap-grid" id="pap_grid"></div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // <html> 上带有 transform/perspective，会破坏 position:fixed 的包含块，
        // 导致 CSS 居中失效（弹窗偏上）。这里用 JS 实测 rect 反推真实偏移并补偿，
        // 对任何坏掉的定位参照系都有效。
        centerFixedBox(box, true);
        window.addEventListener('resize', onWindowResizeCenter);
        box.querySelector('.pap-close').addEventListener('click', closePopup);

        const enabledCb = box.querySelector('#pap_enabled');
        enabledCb.addEventListener('change', () => {
            getSettings().enabled = enabledCb.checked;
            saveSettings();
        });

        const fileInput = box.querySelector('#pap_file_input');
        box.querySelector('#pap_add').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files || []);
            fileInput.value = '';
            if (!files.length) return;
            await handleAddFiles(personaKey, files, box);
        });

        renderGrid(personaKey, box);
    }

    function closePopup() {
        const el = document.getElementById(POPUP_ID);
        if (el) el.remove();
        window.removeEventListener('resize', onWindowResizeCenter);
    }

    // 居中一个 fixed 弹窗，绕开 <html> 上 transform/perspective 破坏的包含块。
    // 做法：先清空 margin，量出当前 rect，再算出与“视口正中”的差值，
    // 用 top/left 直接补偿。无论参照系怎么坏，实测补偿都能精确居中。
    function centerFixedBox(box, trackResize) {
        box.style.margin = '0';
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        // 先归零再测，得到 top/left=0 时元素实际落点（含坏参照系造成的偏移）
        box.style.top = '0px';
        box.style.left = '0px';

        const rect = box.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // 目标：视口正中
        const targetLeft = Math.max(0, (vw - rect.width) / 2);
        const targetTop = Math.max(0, (vh - rect.height) / 2);

        // rect.left/top 是 top:0/left:0 时的实际落点（偏移量）。
        // 要落到 target，就再加上 (target - 实际落点) 的差。
        const fixLeft = targetLeft - rect.left;
        const fixTop = targetTop - rect.top;

        box.style.left = fixLeft + 'px';
        box.style.top = fixTop + 'px';

        // 仅主弹窗需要在窗口尺寸变化时跟随重新居中
        if (trackResize) currentCenteredBox = box;
    }

    let currentCenteredBox = null;
    function onWindowResizeCenter() {
        if (currentCenteredBox && document.body.contains(currentCenteredBox)) {
            centerFixedBox(currentCenteredBox);
        }
    }

    // 把一个 fixed 元素的左上角放到指定的视口像素坐标 (targetLeft, targetTop)。
    // 同样用实测补偿，绕开 <html> transform/perspective 破坏的 fixed 包含块，
    // 否则 top/left/right 百分比或固定值都会相对坏坐标系而飞走。
    function placeFixedBox(box, targetLeft, targetTop) {
        box.style.margin = '0';
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        box.style.top = '0px';
        box.style.left = '0px';
        const rect = box.getBoundingClientRect();
        box.style.left = (targetLeft - rect.left) + 'px';
        box.style.top = (targetTop - rect.top) + 'px';
    }

    async function handleAddFiles(personaKey, files, box) {
        const addBtn = box.querySelector('#pap_add');
        const oldText = addBtn.textContent;
        addBtn.textContent = '上传中...';
        addBtn.classList.add('pap-disabled');

        const pool = getPool(personaKey);
        for (const file of files) {
            try {
                const fileName = await uploadAvatarFile(file);
                if (fileName && !pool.includes(fileName)) {
                    pool.push(fileName);
                }
            } catch (e) {
                console.error('[PersonaAvatarPool] 上传失败:', e);
                toast(`上传失败：${file.name} - ${e.message}`);
            }
        }
        saveSettings();
        addBtn.textContent = oldText;
        addBtn.classList.remove('pap-disabled');
        renderGrid(personaKey, box);
    }

    function renderGrid(personaKey, box) {
        const grid = box.querySelector('#pap_grid');
        const pool = getPool(personaKey);
        box.querySelector('#pap_count').textContent = String(pool.length);
        grid.innerHTML = '';

        if (!pool.length) {
            grid.innerHTML = '<div class="pap-empty">库里还没有图片。点击「添加图片」上传，发言时会随机使用。</div>';
            if (box.classList.contains('pap-box')) centerFixedBox(box, true);
            return;
        }

        pool.forEach((fileName, idx) => {
            const cell = document.createElement('div');
            cell.className = 'pap-cell';

            const img = document.createElement('img');
            // 网格里也显示不压缩的原图；取不到时回退到缩略图
            img.src = fileToFullImage(fileName);
            img.addEventListener('error', () => {
                if (img.dataset.fallback !== '1') {
                    img.dataset.fallback = '1';
                    img.src = fileToForceAvatar(fileName);
                }
            });
            img.title = `${displayName(fileName)}\n点击放大查看`;
            img.loading = 'lazy';
            // 点击缩略图 -> 放大查看原图（可在大图里左右翻页）
            img.addEventListener('click', () => openImageViewer(pool, idx));

            const del = document.createElement('div');
            del.className = 'pap-del fa-solid fa-trash';
            del.title = '从库中移除';
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                await handleDelete(personaKey, fileName, box);
            });

            cell.appendChild(img);
            cell.appendChild(del);
            grid.appendChild(cell);
        });

        // 内容（行数）变化会改变弹窗高度，重新居中一次
        if (box.classList.contains('pap-box')) {
            centerFixedBox(box, true);
        }
    }

    // ---------------------------------------------------------
    // 放大查看：点击库里的缩略图，全屏展示原图，支持左右翻页
    //   list   - 当前 persona 的整库文件名数组
    //   startIndex - 初始展示的下标
    // 操作：← / → 或左右箭头按钮翻页；点空白区域 / 关闭按钮 / Esc 关闭
    //
    // 注意：<html> 上有 transform/perspective，会破坏 position:fixed 的包含块，
    // 让 CSS 居中（flex / margin:auto）失效（小图整体上移）。这里和主弹窗一样，
    // 用 centerFixedBox() 实测像素反推真实偏移、内联写死 top/left，绕开坏参照系。
    // ---------------------------------------------------------
    function openImageViewer(list, startIndex) {
        const files = Array.isArray(list) ? list.slice() : [list];
        if (!files.length) return;
        let cur = Math.max(0, Math.min(startIndex | 0, files.length - 1));

        const exist = document.getElementById('pap_image_viewer');
        if (exist) exist.remove();

        const layer = document.createElement('div');
        layer.id = 'pap_image_viewer';
        layer.className = 'pap-viewer-overlay';

        // 居中容器：fixed 定位，由 centerFixedBox 实测居中
        const content = document.createElement('div');
        content.className = 'pap-viewer-content';

        const img = document.createElement('img');
        img.className = 'pap-viewer-img';
        img.addEventListener('error', () => {
            if (img.dataset.fallback !== '1') {
                img.dataset.fallback = '1';
                img.src = fileToForceAvatar(files[cur]);
            }
        });
        // 图片加载完成后真实尺寸才确定，需要重新居中
        img.addEventListener('load', recenter);

        const caption = document.createElement('div');
        caption.className = 'pap-viewer-caption';

        // 翻页按钮（仅多于一张时显示）
        const prev = document.createElement('div');
        prev.className = 'pap-viewer-nav pap-viewer-prev fa-solid fa-chevron-left';
        prev.title = '上一张';
        const next = document.createElement('div');
        next.className = 'pap-viewer-nav pap-viewer-next fa-solid fa-chevron-right';
        next.title = '下一张';

        const close = document.createElement('div');
        close.className = 'pap-viewer-close fa-solid fa-xmark';
        close.title = '关闭';

        function render() {
            const fileName = files[cur];
            delete img.dataset.fallback;
            // 优先加载原图，画质最佳；原图取不到时回退到缩略图
            img.src = fileToFullImage(fileName);
            img.alt = fileName;
            caption.textContent = files.length > 1
                ? `${displayName(fileName)}  ${cur + 1} / ${files.length}`
                : displayName(fileName);
        }

        function go(delta) {
            cur = (cur + delta + files.length) % files.length;
            render();
        }

        function recenter() {
            if (!document.body.contains(content)) return;
            centerFixedBox(content);
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            // 关闭按钮：右上角（按按钮宽高 40 估算，placeFixedBox 内部会实测补偿）
            placeFixedBox(close, vw - 20 - 40, 16);
            // 翻页箭头：贴左右边、垂直居中（宽高 46）
            if (files.length > 1) {
                placeFixedBox(prev, 16, (vh - 46) / 2);
                placeFixedBox(next, vw - 16 - 46, (vh - 46) / 2);
            }
        }

        function done() {
            layer.remove();
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', recenter);
        }
        function onKey(e) {
            if (e.key === 'Escape') done();
            else if (e.key === 'ArrowLeft') go(-1);
            else if (e.key === 'ArrowRight') go(1);
        }

        // 点遮罩空白处关闭；点图片/箭头/文件名等内容不关闭（方便连续翻页）
        layer.addEventListener('click', (e) => {
            if (e.target === layer) done();
        });
        close.addEventListener('click', (e) => { e.stopPropagation(); done(); });
        prev.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
        next.addEventListener('click', (e) => { e.stopPropagation(); go(1); });
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', recenter);

        content.appendChild(img);
        content.appendChild(caption);
        layer.appendChild(content);
        if (files.length > 1) {
            layer.appendChild(prev);
            layer.appendChild(next);
        }
        layer.appendChild(close);
        document.body.appendChild(layer);

        render();
        // 先按当前（可能还没加载完的）尺寸居中一次，load 后再修正
        recenter();
    }

    async function handleDelete(personaKey, fileName, box) {
        const ok = await confirmDialog(`确定从「${getPersonaDisplayName(personaKey)}」的头像库移除这张图片吗？\n\n${displayName(fileName)}\n\n（同时会从 User Avatars 目录删除该文件）`);
        if (!ok) return;

        // 1) 从库列表移除
        const pool = getPool(personaKey);
        const i = pool.indexOf(fileName);
        if (i >= 0) pool.splice(i, 1);
        saveSettings();

        // 2) 从 User Avatars 目录删除实际文件
        //    注意：若该文件正被用作某 persona 的当前头像，删除可能影响显示，因此用 try。
        try {
            await deleteAvatarFile(fileName);
        } catch (e) {
            console.warn('[PersonaAvatarPool] 删除文件失败（已从库移除）:', e);
        }

        renderGrid(personaKey, box);
    }

    // ---------------------------------------------------------
    // 小工具
    // ---------------------------------------------------------
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function toast(msg) {
        const ctx = getCtx();
        if (ctx && ctx.toastr && typeof ctx.toastr.warning === 'function') {
            ctx.toastr.warning(msg);
        } else if (window.toastr && window.toastr.warning) {
            window.toastr.warning(msg);
        } else {
            console.warn('[PersonaAvatarPool]', msg);
        }
    }

    // 自建确认弹窗：不使用酒馆原生弹窗，避免被头像库弹窗（高 z-index）盖住而无法点击。
    // 该确认层的 z-index 比头像库弹窗更高，始终位于最上层。
    function confirmDialog(text) {
        return new Promise((resolve) => {
            const layer = document.createElement('div');
            layer.className = 'pap-confirm-overlay';

            const box = document.createElement('div');
            box.className = 'pap-confirm-box';

            const msg = document.createElement('div');
            msg.className = 'pap-confirm-msg';
            msg.textContent = text;

            const actions = document.createElement('div');
            actions.className = 'pap-confirm-actions';

            const cancel = document.createElement('button');
            cancel.className = 'menu_button';
            cancel.textContent = '取消';

            const ok = document.createElement('button');
            ok.className = 'menu_button pap-confirm-ok';
            ok.textContent = '确定';

            function done(result) {
                layer.remove();
                resolve(result);
            }

            cancel.addEventListener('click', () => done(false));
            ok.addEventListener('click', () => done(true));
            layer.addEventListener('click', (e) => {
                if (e.target === layer) done(false);
            });

            actions.appendChild(cancel);
            actions.appendChild(ok);
            box.appendChild(msg);
            box.appendChild(actions);
            layer.appendChild(box);
            document.body.appendChild(layer);
            // 同样用 JS 实测居中，绕开 <html> transform/perspective 的影响
            centerFixedBox(box);
        });
    }

    // ---------------------------------------------------------
    // 启动
    // ---------------------------------------------------------
    let initialized = false;
    function init() {
        if (initialized) return; // 防重入（APP_READY 与兜底可能都触发）
        initialized = true;
        getSettings(); // 初始化设置结构
        bindEvents();
        ensureButtonLoop();
        console.log('[PersonaAvatarPool] 已加载');
    }

    function start() {
        const ctx = getCtx();
        if (ctx && ctx.eventSource && ctx.event_types && ctx.event_types.APP_READY) {
            // APP_READY 后再初始化，确保 DOM/上下文就绪
            ctx.eventSource.on(ctx.event_types.APP_READY, init);
            // 若已经 ready（扩展加载较晚），兜底直接初始化
            if (document.getElementById('form_create')) {
                init();
            }
        } else {
            // 上下文还没好，稍后重试
            setTimeout(start, 500);
        }
    }

    start();
})();
