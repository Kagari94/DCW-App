import { useState } from 'react';
import { getToken, setToken } from '../utils/authToken';

function LoginGate({ children }) {
    const [hasToken, setHasToken] = useState(!!getToken());
    const [input, setInput] = useState('');

    function handleSubmit(e) {
        e.preventDefault();
        if (input.trim()) {
            setToken(input.trim());
            setHasToken(true);
        }
    }

    if (hasToken) return children;

    return (
        <div style={{
            width: '100vw', height: '100vh', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: '#111', color: '#ddd'
        }}>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 280 }}>
                <label style={{ fontSize: 13, color: '#999' }}>Enter access token</label>
                <input
                    type="password"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    autoFocus
                    style={{ padding: 8, background: '#222', border: '1px solid #444', color: '#ddd', borderRadius: 4 }}
                />
                <button type="submit" style={{ padding: 8, cursor: 'pointer' }}>Connect</button>
            </form>
        </div>
    );
}

export default LoginGate;