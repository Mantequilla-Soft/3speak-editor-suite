import { useEffect, useState } from 'react'

// Phones in portrait, plus touch devices held sideways (short and coarse)
const PHONE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)'

function matches() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches
}

export default function usePhoneLayout() {
  const [phone, setPhone] = useState(matches)
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY)
    if (!mq) return
    const onChange = () => setPhone(mq.matches)
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return phone
}
