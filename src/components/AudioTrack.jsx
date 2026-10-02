import { useRef } from 'react'
import { Music, X } from 'lucide-react'

function AudioTrack({ backgroundMusic, onAudioAdded, onRemove }) {
  const inputRef = useRef(null)

  const handleClick = () => {
    inputRef.current?.click()
  }

  const handleChange = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      onAudioAdded(file)
    }
    e.target.value = ''
  }

  return (
    <div className="audio-track">
      <h3>Background Music</h3>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        onChange={handleChange}
        style={{ display: 'none' }}
      />

      <div className="audio-track-content">
        {!backgroundMusic ? (
          <button className="add-audio-btn" onClick={handleClick}>
            <Music size={16} style={{ marginRight: '0.5rem' }} />
            Add Background Music
          </button>
        ) : (
          <div className="music-info">
            <Music size={16} />
            <span className="music-name" title={backgroundMusic.name}>
              {backgroundMusic.name}
            </span>
            <button className="remove-music-btn" onClick={onRemove} title="Remove music">
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default AudioTrack
