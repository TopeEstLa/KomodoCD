import "./polyfill";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import dotenv from "dotenv";
import { KomodoClient } from "komodo_client";
import { logger } from "./logger";

dotenv.config();

const komodoRootDirectory = process.env.KOMODO_ROOT_DIRECTORY || "/etc/komodo";
const repoName = process.env.GITOPS_REPO_NAME || "GitOps";
const syncName = process.env.GITOPS_SYNC_NAME || "GitOpsSync";
const komodoUrl = process.env.KOMODO_URL || "localhost:9120";
const komodoKey = process.env.KOMODO_KEY || "";
const komodoSecret = process.env.KOMODO_SECRET || "";
const watchTag = process.env.KOMODO_STACK_TAG || "";

const intervalSeconds = parseInt(process.env.GITOPS_INTERVAL_SECONDS || "120", 10);
const intervalMs = isNaN(intervalSeconds) ? 120000 : intervalSeconds * 1000;

if (!komodoRootDirectory) {
    logger.error("Komodo root directory must be specified via KOMODO_ROOT_DIRECTORY environment variable.");
    process.exit(1);
}

const resolvedRoot = path.resolve(komodoRootDirectory);
const repoPath = path.join(resolvedRoot, "repos", repoName);

if (!komodoKey || !komodoSecret) {
    logger.error("Komodo credentials (KOMODO_KEY, KOMODO_SECRET) must be set.");
    process.exit(1);
}

const komodo = KomodoClient(komodoUrl, {
    type: "api-key",
    params: {
        key: komodoKey,
        secret: komodoSecret,
    },
});

async function getFilesRecursive(dir: string): Promise<string[]> {
    let results: string[] = [];
    let list;
    try {
        list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
        return [];
    }

    for (const file of list) {
        const res = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            if (file.name === ".git" || file.name === "node_modules") {
                continue;
            }
            const subFiles = await getFilesRecursive(res);
            results = results.concat(subFiles);
        } else {
            results.push(res);
        }
    }
    return results;
}

async function computeFileHash(filePath: string): Promise<string> {
    const content = await fs.promises.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
}

async function getDirectoryHashes(baseDir: string): Promise<Map<string, string> | null> {
    try {
        const stat = await fs.promises.stat(baseDir);
        if (!stat.isDirectory()) {
            return null;
        }
    } catch (e) {
        return null;
    }

    const files = await getFilesRecursive(baseDir);
    const hashes = new Map<string, string>();
    for (const file of files) {
        const relativePath = path.relative(baseDir, file).replace(/\\/g, "/");
        try {
            const hash = await computeFileHash(file);
            hashes.set(relativePath, hash);
        } catch (e) {
            logger.warn(`Failed to compute hash for file ${file}:`, e);
        }
    }
    return hashes;
}

//Format komodo operation fail
function printUpdateLogs(update: any) {
    if (!update.success) {
        logger.error(`Komodo Operation ${update.operation} failed!`);
        if (update.logs) {
            for (const log of update.logs) {
                if (!log.success) {
                    logger.error(`[Stage: ${log.stage}] Command: ${log.command}`);
                    if (log.stdout) logger.error(`Stdout:\n${log.stdout}`);
                    if (log.stderr) logger.error(`Stderr:\n${log.stderr}`);
                }
            }
        }
    }
}

async function runGitOpsValidation() {
    logger.info("Starting GitOps validation loop...");

    // 1. Get the list of stacks, filtering by tag if GITOPS_WATCH_TAG is set
    logger.info("Fetching stacks from Komodo...");
    const query: any = {};
    if (watchTag) {
        logger.info(`Filtering stacks by tag: "${watchTag}"`);
        query.tags = [watchTag];
    }

    const stacks = await komodo.read("ListFullStacks", { query });
    logger.info(`Found ${stacks.length} stack(s) to watch.`);

    // 2. Compute the initial hashes of every run directory
    const initialHashesMap = new Map<string, Map<string, string> | null>();

    for (const stack of stacks) {
        const runDir = stack.config?.run_directory;
        if (!runDir) {
            initialHashesMap.set(stack.name, null);
            continue;
        }

        const absoluteRunDir = path.join(repoPath, runDir);
        const hashes = await getDirectoryHashes(absoluteRunDir);
        if (hashes) {
            initialHashesMap.set(stack.name, hashes);
        } else {
            initialHashesMap.set(stack.name, null);
        }
    }

    // 3. Run Git Pull on the GitOps repository in Komodo
    logger.info(`Pulling repo "${repoName}" via Komodo...`);
    const pullUpdate: any = await komodo.execute_and_poll("PullRepo", { repo: repoName });
    if (!pullUpdate.success) {
        printUpdateLogs(pullUpdate);
        throw new Error(`PullRepo on "${repoName}" failed.`);
    }

    // 4. Run Sync on the ResourceSync in Komodo
    logger.info(`Running Sync "${syncName}" via Komodo...`);
    const syncUpdate: any = await komodo.execute_and_poll("RunSync", { sync: syncName });
    if (!syncUpdate.success) {
        printUpdateLogs(syncUpdate);
        throw new Error(`RunSync on "${syncName}" failed.`);
    }

    // 5. Re-check the hashes of every run directory and look for changes
    for (const stack of stacks) {
        const runDir = stack.config?.run_directory;
        if (!runDir) {
            continue;
        }

        const absoluteRunDir = path.join(repoPath, runDir);
        const before = initialHashesMap.get(stack.name) || null;
        const after = await getDirectoryHashes(absoluteRunDir);

        const added: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];

        if (before) {
            for (const [file, hashBefore] of before.entries()) {
                const hashAfter = after ? after.get(file) : null;
                if (!hashAfter) {
                    deleted.push(file);
                } else if (hashAfter !== hashBefore) {
                    modified.push(file);
                }
            }
        }
        if (after) {
            for (const file of after.keys()) {
                if (!before || !before.has(file)) {
                    added.push(file);
                }
            }
        }

        const hasChanged = added.length > 0 || modified.length > 0 || deleted.length > 0;

        if (hasChanged) {
            logger.warn(`[CHANGE DETECTED] Stack "${stack.name}" run directory has changed:`, {
                added: added.length > 0 ? added : undefined,
                modified: modified.length > 0 ? modified : undefined,
                deleted: deleted.length > 0 ? deleted : undefined,
            });

            logger.info(`Triggering deploy on stack "${stack.name}"...`);
            const deployUpdate: any = await komodo.execute_and_poll("DeployStack", { stack: stack.name });
            if (deployUpdate.success) {
                logger.alert(`Successfully deployed stack "${stack.name}".`);
            } else {
                logger.error(`Failed to deploy stack "${stack.name}"!`);
                printUpdateLogs(deployUpdate);
            }
        }
    }

    logger.info("GitOps validation completed successfully.");
}

async function main() {
    logger.info("=========================================");
    logger.info("KomodoCD Daemon Started");
    logger.info(`Komodo root directory: ${resolvedRoot}`);
    logger.info(`GitOps repository path: ${repoPath}`);
    logger.info(`Repository: ${repoName}`);
    logger.info(`ResourceSync: ${syncName}`);
    logger.info(`Komodo Server: ${komodoUrl}`);
    logger.info(`Watch Tag Filter: ${watchTag ? `"${watchTag}"` : "None (watching all)"}`);
    logger.info(`Interval: ${intervalMs / 1000} seconds`);
    logger.info("=========================================");

    while (true) {
        try {
            await runGitOpsValidation();
        } catch (error: any) {
            logger.error("Error during GitOps validation cycle:", error);
        }
        logger.info(`Sleeping for ${intervalMs / 1000} seconds before next run...`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

main().catch(error => {
    logger.error("Fatal error in daemon initialization:", error);
    process.exit(1);
});