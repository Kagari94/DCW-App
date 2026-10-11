import { useRef, useCallback, useEffect } from 'react';
import { VoicePlayback } from '../audio/voicePlayback';

function useVoice() {
    const playbackRef = useRef(null);
    if (playbackRef.current === null) playbackRef.current = new VoicePlayback();

    useEffect(() => () => playbackRef.current.stop(), []);
    const playVoice = useCallback((text, options) => playbackRef.current.play(text, options), []);
    const resetPlaybackSchedule = useCallback(options => playbackRef.current.begin(options), []);
    const enqueueSentence = useCallback(text => playbackRef.current.enqueue(text), []);
    const waitForPlaybackToFinish = useCallback(() => playbackRef.current.wait(), []);
    const stopVoice = useCallback(() => playbackRef.current.stop(), []);
    const prepareVoice = useCallback(() => playbackRef.current.getContext(), []);
    const isPlaying = useCallback(() => playbackRef.current.sessions.size > 0, []);

    return { playVoice, resetPlaybackSchedule, enqueueSentence, waitForPlaybackToFinish, stopVoice, prepareVoice, isPlaying };
}

export default useVoice;
