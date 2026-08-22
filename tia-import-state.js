(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TiaImportState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // 双确认的第二道闸：preflight 拿到事实后，导入请求先挂在 state 里，
    // 只有用户点「确认写入」才会真正发出 /api/tia/import。
    // 取消/关闭模态框 → clear() → 永不发出请求。
    function createTiaImportState() {
        let pending = null;

        return {
            // 暂存待确认的导入：{ xml, overwrite, token, confirmationToken }
            set(payload) {
                pending = payload || null;
            },
            // 取消：清空待确认状态
            clear() {
                pending = null;
            },
            get() {
                return pending;
            },
            // 用户确认：只允许成功发出一次导入请求，之后 pending 清空
            async confirm(fetcher) {
                if (!pending) return null;
                const payload = pending;
                pending = null;

                const { xml, overwrite, token, confirmationToken } = payload;
                const response = await fetcher('/api/tia/import', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({
                        xml,
                        confirmed: true,
                        overwrite: !!overwrite,
                        confirmationToken
                    })
                });
                return response && typeof response.json === 'function'
                    ? await response.json()
                    : response;
            }
        };
    }

    return { createTiaImportState };
});
