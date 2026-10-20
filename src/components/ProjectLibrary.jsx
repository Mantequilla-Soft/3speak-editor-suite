import { useState, useRef } from 'react'
import { Film, Music, Image, X, Plus, Upload, Download } from 'lucide-react'

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function LibraryItem({ item, isSelected, downloadStatus, onSelect, onRemove, onAddToTimeline }) {
  // Items can go on the timeline while they upload: the preview plays the
  // local file and the upload finishes in the background
  const isEncoding = false

  const handleDragStart = (e) => {
    if (isEncoding) { e.preventDefault(); return }
    e.dataTransfer.setData('libraryItemId', item.id)
    e.dataTransfer.setData('itemType', item.type)
  }

  const getIcon = () => {
    switch (item.type) {
      case 'video': return <Film size={16} />
      case 'audio': return <Music size={16} />
      case 'image': return <Image size={16} />
      default: return null
    }
  }

  const getThumbnail = () => {
    if (item.type === 'video') {
      return <video src={item.url} muted />
    }
    if (item.type === 'image') {
      return <img src={item.url} alt={item.name} />
    }
    return (
      <div className="audio-icon">
        <Music size={20} />
      </div>
    )
  }

  return (
    <div
      className={`library-item ${isSelected ? 'selected' : ''} ${isEncoding ? 'encoding' : ''}`}
      onClick={() => onSelect(item.id)}
      draggable={!isEncoding}
      onDragStart={handleDragStart}
    >
      <div className="library-item-thumbnail">
        {getThumbnail()}
      </div>
      <div className="library-item-info">
        <span className="library-item-name" title={item.name}>
          {getIcon()}
          {item.name}
        </span>
        <span className="library-item-duration">
          {formatDuration(item.duration)}
          {downloadStatus?.status === 'downloading' && (
            <span className="hls-dl-badge" title={`Downloading... ${Math.round(downloadStatus.progress * 100)}%`}>
              <Download size={9} /> {Math.round(downloadStatus.progress * 100)}%
            </span>
          )}
          {downloadStatus?.status === 'done' && (
            <span className="hls-dl-badge done" title="Downloaded locally">local</span>
          )}
          {item.uploading && !item.serverUrl && (
            <span className="hls-dl-badge" title="Uploading in the background. Render waits until it is done.">
              <Upload size={9} /> {Math.round((item.uploadProgress || 0) * 100)}%
            </span>
          )}
          {item.converting && (
            <span className="hls-dl-badge" title="This browser cannot show this video's format. The preview switches to a 480p copy once it is ready.">
              <Upload size={9} /> converting
            </span>
          )}
          {item.convertFailed && (
            <span className="hls-dl-badge" title="Could not make a playable copy. The preview may stay black, rendering still works.">no preview</span>
          )}
          {item.serverUrl && !item.converting && !item.convertFailed && (
            <span className="hls-dl-badge done" title="Encoded to 480p on server">480p</span>
          )}
        </span>
      </div>
      <div className="library-item-actions">
        <button
          onClick={(e) => { e.stopPropagation(); if (!isEncoding) onAddToTimeline(item.id) }}
          title={isEncoding ? "Encoding..." : "Add to timeline"}
          disabled={isEncoding}
        >
          <Plus size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(item.id) }}
          title="Remove from library"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}

function ProjectLibrary({
  library,
  selectedLibraryId,
  hlsDownloads,
  onSelectItem,
  onRemoveItem,
  onAddToTimeline,
  onFilesAdded
}) {
  const [dragover, setDragover] = useState(false)
  const inputRef = useRef(null)

  const items = library || []
  const videos = items.filter(item => item.type === 'video')
  const images = items.filter(item => item.type === 'image')
  const sounds = items.filter(item => item.type === 'audio')

  const handleDragOver = (e) => {
    // Only show drop state for external file drops
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.stopPropagation()
      setDragover(true)
    }
  }

  const handleDragLeave = (e) => {
    // Only clear if leaving the library container
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragover(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragover(false)

    const files = Array.from(e.dataTransfer.files).filter(
      file => file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')
    )

    if (files.length > 0 && onFilesAdded) {
      onFilesAdded(files)
    }
  }

  const handleClick = () => {
    inputRef.current?.click()
  }

  const handleChange = (e) => {
    const files = Array.from(e.target.files)
    if (files.length > 0 && onFilesAdded) {
      onFilesAdded(files)
    }
    e.target.value = ''
  }

  const renderGroup = (title, items, icon) => (
    <div className="library-group">
      <div className="library-group-header">
        {icon}
        <span>{title}</span>
        <span className="library-group-count">{items.length}</span>
      </div>
      <div className="library-group-items">
        {items.length === 0 ? (
          <div className="library-empty">No {title.toLowerCase()}</div>
        ) : (
          items.map(item => (
            <LibraryItem
              key={item.id}
              item={item}
              isSelected={item.id === selectedLibraryId}
              downloadStatus={hlsDownloads?.[item.id]}
              onSelect={onSelectItem}
              onRemove={onRemoveItem}
              onAddToTimeline={onAddToTimeline}
            />
          ))
        )}
      </div>
    </div>
  )

  return (
    <div
      className={`project-library ${dragover ? 'dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="library-header">
        <h3>Project Library</h3>
        <button className="add-files-btn" onClick={handleClick} title="Add files">
          <Upload size={14} />
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*,image/*"
        multiple
        onChange={handleChange}
        style={{ display: 'none' }}
      />
      <div className="library-content">
        {renderGroup('Videos', videos, <Film size={14} />)}
        {renderGroup('Images', images, <Image size={14} />)}
        {renderGroup('Sounds', sounds, <Music size={14} />)}
      </div>
      <div className="library-hint">
        {dragover ? 'Drop files to add' : 'Drop files here or drag items to timeline'}
      </div>
    </div>
  )
}

export default ProjectLibrary
