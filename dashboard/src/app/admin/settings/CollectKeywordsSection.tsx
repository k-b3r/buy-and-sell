import InfoTooltip from '../../InfoTooltip'
import SaveControls from './SaveControls'
import type { CollectKeywordsEditor } from './useCollectKeywords'

export default function CollectKeywordsSection({ editor }: { editor: CollectKeywordsEditor }) {
  const {
    keywords,
    keywordsLoaded,
    newKeyword,
    setNewKeyword,
    keywordsSaveState,
    keywordsSaveError,
    handleAddKeyword,
    handleRemoveKeyword,
    handleToggleKeyword,
    handleSaveKeywords,
  } = editor

  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: 16,
        marginTop: 16,
      }}
    >
      <h2
        className="mono"
        style={{ fontSize: '1em', marginTop: 0, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        Search keywords
        <InfoTooltip
          text="Motivated-seller phrases the collector searches on --cycle laps (e.g. 'rush sale', 'moving out'). Add or remove as many as you like — collect loops through every enabled one, every lap. Untick to skip a keyword without deleting it."
          style={{ color: 'var(--color-text-muted)' }}
        />
      </h2>
      {!keywordsLoaded ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, marginBottom: 12 }}>
            {keywords.map(({ keyword, enabled }) => (
              <span
                key={keyword}
                style={{
                  opacity: enabled ? 1 : 0.5,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  padding: '4px 8px',
                  fontSize: '0.85em',
                }}
              >
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={enabled} onChange={() => handleToggleKeyword(keyword)} />
                  <span style={{ textDecoration: enabled ? 'none' : 'line-through' }}>{keyword}</span>
                </label>
                <button
                  onClick={() => handleRemoveKeyword(keyword)}
                  aria-label={`Remove "${keyword}"`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            {keywords.length === 0 && (
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>No keywords yet.</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddKeyword()
                }
              }}
              placeholder="add a keyword…"
              style={{
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '4px 8px',
                color: 'var(--color-text)',
                fontSize: '0.85em',
                width: 200,
              }}
            />
            <button
              onClick={handleAddKeyword}
              style={{
                background: 'transparent',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: '4px 12px',
                fontSize: '0.85em',
                cursor: 'pointer',
              }}
            >
              Add
            </button>
          </div>
          <SaveControls state={keywordsSaveState} error={keywordsSaveError} onSave={handleSaveKeywords} />
        </>
      )}
    </div>
  )
}
