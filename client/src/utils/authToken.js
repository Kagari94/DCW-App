const STORAGE_KEY = 'app_access_token';

export function getToken() {
    return localStorage.getItem(STORAGE_KEY);
}

export function setToken(token) {
    localStorage.setItem(STORAGE_KEY, token);
}

export function authHeaders() {
    const token = getToken();
    return token ? { 'x-app-token': token } : {};
}