import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Global keyboard shortcuts:
 * - g t → Go to Topics (/)
 * - g a → Go to Agents (/agents)
 * - g o → Go to Ops (/ops)
 * - g d → Toggle dark/light theme
 * - Escape → Go back
 */
export function useKeyboardShortcuts(toggleTheme: () => void) {
  const navigate = useNavigate();

  useEffect(() => {
    let gPressed = false;
    let gTimer: ReturnType<typeof setTimeout>;

    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        gPressed = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(() => { gPressed = false; }, 600);
        return;
      }

      if (gPressed) {
        gPressed = false;
        clearTimeout(gTimer);
        switch (e.key) {
          case 't': e.preventDefault(); navigate('/'); break;
          case 'a': e.preventDefault(); navigate('/agents'); break;
          case 'o': e.preventDefault(); navigate('/ops'); break;
          case 'd': e.preventDefault(); toggleTheme(); break;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        navigate(-1);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(gTimer);
    };
  }, [navigate, toggleTheme]);
}
