function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(1)
  return `${mins}:${secs.padStart(4, '0')}`
}

function TrimControls({ clip, onUpdate }) {
  const handleStartChange = (e) => {
    const newStart = parseFloat(e.target.value)
    if (newStart < clip.endTime) {
      onUpdate({ startTime: newStart })
    }
  }

  const handleEndChange = (e) => {
    const newEnd = parseFloat(e.target.value)
    if (newEnd > clip.startTime) {
      onUpdate({ endTime: newEnd })
    }
  }

  return (
    <div className="trim-controls">
      <h3>Trim: {clip.name}</h3>

      <div className="trim-control">
        <label>Start Point</label>
        <input
          type="range"
          min={0}
          max={clip.duration}
          step={0.1}
          value={clip.startTime}
          onChange={handleStartChange}
        />
        <span className="value">{formatTime(clip.startTime)}</span>
      </div>

      <div className="trim-control">
        <label>End Point</label>
        <input
          type="range"
          min={0}
          max={clip.duration}
          step={0.1}
          value={clip.endTime}
          onChange={handleEndChange}
        />
        <span className="value">{formatTime(clip.endTime)}</span>
      </div>

      <div className="trim-control">
        <label>Trimmed Duration</label>
        <span className="value">{formatTime(clip.endTime - clip.startTime)}</span>
      </div>
    </div>
  )
}

export default TrimControls
