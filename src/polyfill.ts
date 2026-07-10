// Polyfill localStorage for Node.js environments where mock_auth_client is imported.
const mockLocalStorage = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
        length: 0,
        key: (index: number) => null,
    };
})();

(globalThis as any).localStorage = mockLocalStorage;
