import { useRef, useState, useCallback, useEffect } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';

const CAPTURE_INTERVAL_MS = 5000;

// Manages a live webcam session for the background vision-gatekeeper
// feature. Captures a JPEG frame and POSTs it to POST /api/vision/frame —
// the NEXT capture is only scheduled after the CURRENT upload's response
// comes back, never on a bare setInterval, so a slow (CPU-bound)
// gatekeeper on the .145 machine naturally stretches the effective
// interval instead of piling up overlapping requests. See
// server/routes/vision.js's own overlap guard for the server-side version
// of the same idea.
export default function useLiveCamera() {
    const [active, setActive] = useState(false);
    const streamRef = useRef(null);
    const videoRef = useRef(null);
    const activeRef = useRef(false); // mirrors `active`, read synchronously inside the async loop
    const startRequestRef = useRef(0);
    const startingRef = useRef(false);
    const timeoutRef = useRef(null);

    const captureAndSendFrame = useCallback(async () => {
        const video = videoRef.current;
        if (!video || !activeRef.current) return;

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (!blob || !activeRef.current) return;

        const formData = new FormData();
        formData.append('frame', blob, 'frame.jpg');

        try {
            await apiFetch('/api/vision/frame', {
                method: 'POST',
                headers: authHeaders(),
                body: formData,
            });
        } catch (err) {
            // Non-fatal — one missed frame just means one skipped check.
            console.error('Camera frame upload failed:', err.message);
        }
    }, []);

    const loop = useCallback(async function loop() {
        if (!activeRef.current) return;
        await captureAndSendFrame();
        if (!activeRef.current) return;
        timeoutRef.current = setTimeout(loop, CAPTURE_INTERVAL_MS);
    }, [captureAndSendFrame]);

    const stop = useCallback(() => {
        startRequestRef.current++;
        activeRef.current = false;
        setActive(false);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        videoRef.current = null;
    }, []);

    const start = useCallback(async () => {
        if (activeRef.current) return true;
        if (startingRef.current) return false;
        startingRef.current = true;
        const request = ++startRequestRef.current;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true });
            if (request !== startRequestRef.current) {
                stream.getTracks().forEach(track => track.stop());
                return false;
            }
            streamRef.current = stream;

            const video = document.createElement('video');
            video.srcObject = stream;
            await video.play();
            if (request !== startRequestRef.current) {
                stream.getTracks().forEach(track => track.stop());
                return false;
            }
            videoRef.current = video;

            // Fires if the user stops sharing via the browser's own native
            // indicator rather than the app's toggle — keeps state honest
            // either way, same pattern as the screen-share session.
            stream.getVideoTracks()[0].addEventListener('ended', () => stop());

            activeRef.current = true;
            setActive(true);
            loop();
            return true;
        } catch (err) {
            stream?.getTracks().forEach(track => track.stop());
            streamRef.current = null;
            videoRef.current = null;
            if (request === startRequestRef.current && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
                console.error('Camera session failed to start:', err);
                alert(`⚠️ Camera access failed: ${err.message}`);
            }
            return false;
        } finally {
            startingRef.current = false;
        }
    }, [loop, stop]);

    useEffect(() => stop, [stop]); // stop the camera on unmount, no matter what

    return { active, start, stop };
}
