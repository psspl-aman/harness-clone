import type { AttachmentDto, StagedAttachmentDto } from '@ai-harness/shared';
import JSZip from 'jszip';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { badRequest } from '../http/errors';
import { excludeProjectDataDir, projectDataDir } from '../lib/project-data-dir';
import { newId } from '../lib/id';

/** Where a project's attachments live (inside its data folder, so never committed). */
const attachDir = (projectRoot: string) => join(projectDataDir(projectRoot), 'attachments');
/** Staged uploads not claimed by a project within this time are removed. */
const STAGING_TTL_MS = 24 * 60 * 60_000;

/** Windows releases file handles asynchronously; retry instead of failing with EPERM. */
const RM_DIR = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

const ATTACHMENT_ID_RE = /^att_[a-z0-9]+$/;
const STAGED_ID_RE = /^stg_[a-z0-9]+$/;

export interface UploadedFile {
  filename: string;
  mimetype: string;
  data: Buffer;
}

interface StagedMeta extends StagedAttachmentDto {
  /** File name inside the staging folder. */
  file: string;
  stagedAt: number;
}

export interface AttachmentStoreDeps {
  /** AI_HARNESS_HOME/attachments: staging for uploads made before a project exists. */
  root: string;
  log: { warn: (obj: unknown, msg: string) => void };
}

/**
 * Files people attach to requirements. Chat uploads go straight into the project; uploads
 * from the new-project wizard are staged under AI_HARNESS_HOME until the project exists,
 * then claimed into it. Word files also get a plain-text copy, because the agent CLIs
 * can read text, PDFs and images but not .docx.
 */
export class AttachmentStore {
  private readonly stagingDir: string;

  constructor(private readonly deps: AttachmentStoreDeps) {
    this.stagingDir = join(deps.root, 'staging');
  }

  async saveToProject(projectRoot: string, file: UploadedFile): Promise<AttachmentDto> {
    const id = newId('att');
    const name = safeName(file.filename);
    const dir = join(attachDir(projectRoot), id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, file.data);
    const textPath = await this.writeTextCopy(dir, name, file.data);
    const meta: AttachmentDto = {
      id,
      name,
      mime: file.mimetype || 'application/octet-stream',
      size: file.data.length,
      path,
      textPath,
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    excludeProjectDataDir(projectRoot);
    return meta;
  }

  load(projectRoot: string, id: string): AttachmentDto {
    if (!ATTACHMENT_ID_RE.test(id)) throw badRequest('Invalid attachment id');
    const metaPath = join(attachDir(projectRoot), id, 'meta.json');
    if (!existsSync(metaPath)) throw badRequest(`Attachment ${id} not found`);
    return JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentDto;
  }

  /** Keep an upload until a project claims it (new-project wizard). */
  stage(file: UploadedFile): StagedAttachmentDto {
    this.sweepStaging();
    const id = newId('stg');
    const name = safeName(file.filename);
    const dir = join(this.stagingDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), file.data);
    const meta: StagedMeta = {
      id,
      name,
      mime: file.mimetype || 'application/octet-stream',
      size: file.data.length,
      file: name,
      stagedAt: Date.now(),
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    return { id, name, mime: meta.mime, size: meta.size };
  }

  /**
   * Move staged uploads into a project. Every id is checked before anything moves, so a
   * bad id leaves all files staged.
   */
  async claim(projectRoot: string, stagedIds: string[]): Promise<AttachmentDto[]> {
    const staged = stagedIds.map((id) => this.readStaged(id));
    const saved: AttachmentDto[] = [];
    for (const s of staged) {
      const dir = join(this.stagingDir, s.id);
      saved.push(
        await this.saveToProject(projectRoot, {
          filename: s.name,
          mimetype: s.mime,
          data: readFileSync(join(dir, s.file)),
        }),
      );
      rmSync(dir, RM_DIR);
    }
    return saved;
  }

  /** Remove staged uploads that were never claimed (wizard abandoned). */
  sweepStaging(now = Date.now()): void {
    if (!existsSync(this.stagingDir)) return;
    for (const id of readdirSync(this.stagingDir)) {
      const dir = join(this.stagingDir, id);
      try {
        if (now - statSync(dir).mtimeMs > STAGING_TTL_MS) rmSync(dir, RM_DIR);
      } catch (err) {
        this.deps.log.warn({ err, dir }, 'could not clean up a staged attachment');
      }
    }
  }

  /** Throws unless every id is a staged upload that can still be claimed. */
  assertStaged(stagedIds: string[]): void {
    for (const id of stagedIds) this.readStaged(id);
  }

  private readStaged(id: string): StagedMeta {
    if (!STAGED_ID_RE.test(id)) throw badRequest('Invalid upload id');
    const metaPath = join(this.stagingDir, id, 'meta.json');
    if (!existsSync(metaPath))
      throw badRequest('An attached file expired or was already used — attach it again');
    return JSON.parse(readFileSync(metaPath, 'utf8')) as StagedMeta;
  }

  /** A `.txt` copy of a Word document next to it, or null for other files. */
  private async writeTextCopy(dir: string, name: string, data: Buffer): Promise<string | null> {
    if (extname(name).toLowerCase() !== '.docx') return null;
    try {
      const text = await docxToText(data);
      if (!text.trim()) return null;
      const path = join(dir, `${basename(name, extname(name))}.txt`);
      writeFileSync(path, text);
      return path;
    } catch (err) {
      // Not a valid .docx: keep the original only; the agent may still make sense of it.
      this.deps.log.warn({ err, name }, 'could not extract text from a Word document');
      return null;
    }
  }
}

function safeName(filename: string): string {
  return (
    basename(filename)
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 120) || 'file'
  );
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Paragraph text of a .docx (WordprocessingML), one paragraph per line. */
export async function docxToText(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (xml === undefined) throw new Error('word/document.xml missing');
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(br|cr)\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m: string, e: string) => XML_ENTITIES[e]!)
    .replace(/&#(x?)([0-9a-f]+);/gi, (_m: string, hex: string, n: string) =>
      String.fromCodePoint(parseInt(n, hex ? 16 : 10)),
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
