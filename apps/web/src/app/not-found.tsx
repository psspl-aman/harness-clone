import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-muted-foreground font-mono text-sm">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to projects</Link>
      </Button>
    </div>
  );
}
