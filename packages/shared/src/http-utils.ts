type HeaderValueLike = string[] | string | undefined;

interface HttpContextLike {
    headers: Record<string, HeaderValueLike>;
}



export function forEachHeaderValue(
    input: HttpContextLike | Record<string, HeaderValueLike>,
    headerName: string,
    consumer: (value: string) => void,
): void {
    if (!input) return;
    else if ("headers" in input) {
        const headers = input.headers;
        if (typeof headers === 'object' && headers !== null) {
            return forEachHeaderValue(headers as Record<string, HeaderValueLike>, headerName, consumer);
        }
    }
    const target = headerName.toLowerCase();
    for (const [key, value] of Object.entries(input)) {
        if (value == null || key.toLowerCase() !== target) {
            continue;
        } else if (Array.isArray(value)) {
            for (const item of value) {
                consumer(item);
            }
        } else {
            consumer(value);
        }
    }

}

export function parseCookies(input: HttpContextLike | Record<string, HeaderValueLike> | HeaderValueLike): Record<string, string> {
    if (!input) return {}
    const cookies: Record<string, string> = {};
    function appendCookies(cookies: Record<string, string>) {
        for (const [key, value] of Object.entries(cookies)) {
            if (key in cookies) continue;
            cookies[key] = value;
        }
    }

    if (typeof input !== 'string') {
        if (Array.isArray(input)) {
            for (const item of input) {
                appendCookies(parseCookies(item));
            }
            return cookies;
        };
        forEachHeaderValue(input, 'cookie', (value) => {
            appendCookies(parseCookies(value));
        });
        return cookies;
    } else {
        for (const part of input.split(";")) {
            const eq = part.indexOf("=");
            if (eq < 0) continue;
            const name = part.slice(0, eq).trim();
            if (!name || name in cookies) continue;
            const raw = part.slice(eq + 1).trim();
            cookies[name] = decodeURIComponent(raw);
        }
        return cookies;
    }
}
