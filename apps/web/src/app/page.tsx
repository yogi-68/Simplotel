import { ChatShell } from '@/components/ChatShell';

/**
 * One screen, no navigation. A guest with a question should never have to
 * decide which page their question belongs on.
 */
export default function Page() {
  return <ChatShell />;
}
