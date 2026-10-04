import { useEffect, useState } from 'react'
import type { SaveState } from './settingsTypes'

interface CollectKeyword {
  keyword: string
  enabled: boolean
}

// collect's search-query list - a row editor (add/remove/toggle keywords), not
// number knobs, hence its own state/endpoint separate from useSettingValues'
// `/api/settings`. Owned by the page (not the keyword section) so unsaved
// edits survive switching tabs.
export function useCollectKeywords() {
  const [keywords, setKeywords] = useState<CollectKeyword[]>([])
  const [keywordsLoaded, setKeywordsLoaded] = useState(false)
  const [newKeyword, setNewKeyword] = useState('')
  const [keywordsSaveState, setKeywordsSaveState] = useState<SaveState>('idle')
  const [keywordsSaveError, setKeywordsSaveError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function loadKeywords() {
      try {
        const res = await fetch('/api/collect-keywords')
        const body = (await res.json()) as { keywords?: CollectKeyword[] }
        if (!cancelled && res.ok) {
          setKeywords(body.keywords ?? [])
          setKeywordsLoaded(true)
        }
      } catch {
        // best-effort - the collect tab just won't show the keyword editor if this fails
      }
    }
    void loadKeywords()
    return () => {
      cancelled = true
    }
  }, [])

  function handleAddKeyword() {
    const trimmed = newKeyword.trim().toLowerCase()
    if (trimmed === '' || keywords.some((k) => k.keyword === trimmed)) return
    setKeywords((prev) => [...prev, { keyword: trimmed, enabled: true }])
    setNewKeyword('')
  }

  function handleRemoveKeyword(keyword: string) {
    setKeywords((prev) => prev.filter((k) => k.keyword !== keyword))
  }

  function handleToggleKeyword(keyword: string) {
    setKeywords((prev) => prev.map((k) => (k.keyword === keyword ? { ...k, enabled: !k.enabled } : k)))
  }

  async function handleSaveKeywords() {
    setKeywordsSaveState('saving')
    setKeywordsSaveError('')
    try {
      const res = await fetch('/api/collect-keywords', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keywords }),
      })
      const body = await res.json()
      if (!res.ok) {
        setKeywordsSaveState('error')
        setKeywordsSaveError(body.error ?? 'Save failed')
        return
      }
      setKeywordsSaveState('saved')
      setTimeout(() => setKeywordsSaveState((prev) => (prev === 'saved' ? 'idle' : prev)), 2000)
    } catch {
      setKeywordsSaveState('error')
      setKeywordsSaveError('Could not reach the settings API')
    }
  }

  return {
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
  }
}

export type CollectKeywordsEditor = ReturnType<typeof useCollectKeywords>
