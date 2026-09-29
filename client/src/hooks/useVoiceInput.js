import { useRef, useState, useCallback, useEffect } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';
import { blobToWav16kMono } from '../utils/audioCapture';
import { playWakeAcknowledgeChime } from '../utils/chime';

const DEFAULT_COMMAND_MODEL = 'Xenova/whisper-base.en';
const DEFAULT_POLL_MODEL = 'Xenova/whisper-tiny.en';

export default function useVoiceInput(settings, onCommand) {
    const [isListening, setIsListening] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [awaitingCommand, setAwaitingCommand] = useState(false);
    const mediaRecorderRef = useRef(null);
    const streamRef = useRef(null);
    const mountedRef = useRef(false);
    const pushRequestedRef = useRef(false);
    const wakeWordActiveRef = useRef(false);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            pushRequestedRef.current = false;
            const recorder = mediaRecorderRef.current;
            if (recorder) {
                recorder.onstop = null;
                if (recorder.state === 'recording') recorder.stop();
            }
            streamRef.current?.getTracks().forEach(track => track.stop());
        };
    }, []);

    const voiceConfig = settings?.voiceInput;

    const transcribeBlob = useCallback(async (blob, modelOverride) => {
        const wavBlob = await blobToWav16kMono(blob);
        const formData = new FormData();
        formData.append('audio', wavBlob, 'clip.wav');
        if (modelOverride) formData.append('model', modelOverride);

        const res = await apiFetch('/api/transcribe', {
            method: 'POST',
            headers: authHeaders(),
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Transcription failed');
        return data.text || '';
    }, []);

    const startPushToTalk = useCallback(async () => {
        if (mediaRecorderRef.current || pushRequestedRef.current) return;
        pushRequestedRef.current = true;

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            pushRequestedRef.current = false;
            if (!mountedRef.current) return;
            console.error('Microphone access denied or unavailable:', err);
            alert('⚠️ Could not access microphone. Check browser permissions.');
            return;
        }

        if (!mountedRef.current || !pushRequestedRef.current) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            streamRef.current = null;
            mediaRecorderRef.current = null;
            setIsListening(false);

            if (!mountedRef.current || chunks.length === 0) return;
            setIsTranscribing(true);
            try {
                const text = await transcribeBlob(new Blob(chunks));
                if (mountedRef.current && text) onCommand(text, 'push-to-talk');
            } catch (err) {
                console.error('Voice transcription failed:', err);
                alert(`⚠️ Transcription failed: ${err.message}`);
            } finally {
                setIsTranscribing(false);
            }
        };
        recorder.start();
        mediaRecorderRef.current = recorder;
        setIsListening(true);
    }, [onCommand, transcribeBlob]);

    const stopPushToTalk = useCallback(() => {
        pushRequestedRef.current = false;
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
    }, []);

    useEffect(() => {
        if (!voiceConfig?.enabled || voiceConfig.mode !== 'wake-word') return;

        let cancelled = false;
        let stream = null;
        let recorder = null;
        wakeWordActiveRef.current = false;
        const CHUNK_MS = 4000;
        const commandModel = voiceConfig.whisperModel || DEFAULT_COMMAND_MODEL;
        const pollModel = voiceConfig.wakeWordPollModel || DEFAULT_POLL_MODEL;

        function handleChunkTranscript(text) {
            const wakeWord = (voiceConfig.wakeWord || '').toLowerCase().trim();
            if (!wakeWord) return;
            const lower = text.toLowerCase();

            if (!wakeWordActiveRef.current) {
                const idx = lower.indexOf(wakeWord);
                if (idx === -1) return;

                playWakeAcknowledgeChime();

                const after = text.slice(idx + wakeWord.length).trim();
                if (after) {
                    onCommand(after, 'wake-word');
                } else {
                    wakeWordActiveRef.current = true;
                    setAwaitingCommand(true);
                }
            } else {
                wakeWordActiveRef.current = false;
                setAwaitingCommand(false);
                if (text.trim()) onCommand(text.trim(), 'wake-word');
            }
        }

        function recordOneChunk() {
            if (cancelled || !stream) return;

            const modelForThisChunk = wakeWordActiveRef.current ? commandModel : pollModel;

            const chunks = [];
            recorder = new MediaRecorder(stream);
            recorder.ondataavailable = (e) => chunks.push(e.data);
            recorder.onstop = () => {
                if (cancelled) return;

                recordOneChunk();

                if (chunks.length > 0) {
                    transcribeBlob(new Blob(chunks), modelForThisChunk)
                        .then((text) => {
                            if (!cancelled && text) handleChunkTranscript(text);
                        })
                        .catch((err) => console.error('Wake-word transcription failed:', err));
                }
            };
            recorder.start();
            setTimeout(() => {
                if (recorder?.state === 'recording') recorder.stop();
            }, CHUNK_MS);
        }

        async function start() {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err) {
                console.error('Microphone access denied or unavailable:', err);
                return;
            }
            if (cancelled) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }
            streamRef.current = stream;
            setIsListening(true);
            setAwaitingCommand(false);
            recordOneChunk();
        }

        start();

        return () => {
            cancelled = true;
            if (recorder?.state === 'recording') recorder.stop();
            stream?.getTracks().forEach(t => t.stop());
            streamRef.current = null;
            setIsListening(false);
            setAwaitingCommand(false);
        };
    }, [
        voiceConfig?.enabled,
        voiceConfig?.mode,
        voiceConfig?.wakeWord,
        voiceConfig?.whisperModel,
        voiceConfig?.wakeWordPollModel,
        onCommand,
        transcribeBlob,
    ]);

    return {
        isListening,
        isTranscribing,
        awaitingCommand,
        startPushToTalk,
        stopPushToTalk,
        pushToTalkAvailable: Boolean(voiceConfig?.enabled && voiceConfig.mode === 'push-to-talk'),
    };
}