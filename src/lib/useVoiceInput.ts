import { useRef, useState } from 'react'
import { supabase } from './supabase'

type Status = 'idle' | 'recording' | 'transcribing'

const API_BASE = import.meta.env.VITE_API_BASE as string

export function useVoiceInput(onResult: (text: string) => void) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        void handleStopped()
      }
      recorderRef.current = recorder
      recorder.start()
      setStatus('recording')
    } catch {
      setError('無法使用麥克風，請確認已授權存取權限。')
    }
  }

  const stop = () => {
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
  }

  const handleStopped = async () => {
    setStatus('transcribing')
    try {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('no session')

      const form = new FormData()
      form.append('audio', blob, 'recording.webm')

      const resp = await fetch(`${API_BASE}/api/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      if (!resp.ok) throw new Error('transcribe failed')
      const data = (await resp.json()) as { text: string }
      onResult(data.text)
    } catch {
      setError('語音辨識失敗，請再試一次或改用文字輸入。')
    } finally {
      setStatus('idle')
    }
  }

  return { status, error, start, stop }
}
