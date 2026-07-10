import "./polyfill";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import dotenv from "dotenv";
import { KomodoClient } from "komodo_client";

// Load environment variables from .env
dotenv.config();

// Read configurations from process.env (No CLI arguments)
let mountPath = process.env.GITOPS_MOUNT_PATH || "";
const repoName = process.env.GITOPS_REPO_NAME || "GitOps";
const syncName = process.env.GITOPS_SYNC_NAME || "GitOpsSync";
const komodoUrl = process.env.KOMODO_URL || "localhost:9120";
const komodoKey = process.env.KOMODO_KEY || "";
const komodoSecret = process.env.KOMODO_SECRET || "";
const watchTag = process.env.KOMODO_STACK_TAG || "";

const intervalSeconds = parseInt(process.env.GITOPS_INTERVAL_SECONDS || "120", 10);
const intervalMs = isNaN(intervalSeconds) ? 120000 : intervalSeconds * 1000;

// Ensure mountPath exists and is absolute
if (!mountPath) {
    console.error("Error: GitOps mount path must be specified via GITOPS_MOUNT_PATH environment variable.");
    process.exit(1);
}
mountPath = path.resolve(mountPath);

if (!komodoKey || !komodoSecret) {
    console.error("Error: Komodo credentials (KOMODO_KEY, KOMODO_SECRET) must be set.");
    process.exit(1);
}

// Initialize Komodo client
const komodo = KomodoClient(komodoUrl, {
    type: "api-key",
    params: {
        key: komodoKey,
        secret: komodoSecret,
    },
});

// Recursively scan a directory and return absolute paths of all files
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

// Compute the SHA-256 hash of a file's contents
async function computeFileHash(filePath: string): Promise<string> {
    const content = await fs.promises.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
}

// Get file path to hash mapping for a directory
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
            console.warn(`Warning: failed to compute hash for file ${file}:`, e);
        }
    }
    return hashes;
}

// Formats log output if a Komodo command fails
function printUpdateLogs(update: any) {
    if (!update.success) {
        console.error(`Operation ${update.operation} failed!`);
        if (update.logs) {
            for (const log of update.logs) {
                if (!log.success) {
                    console.error(`[Stage: ${log.stage}] Command: ${log.command}`);
                    if (log.stdout) console.error(`Stdout:\n${log.stdout}`);
                    if (log.stderr) console.error(`Stderr:\n${log.stderr}`);
                }
            }
        }
    }
}

// Main execution block representing one iteration of GitOps validation
async function runGitOpsValidation() {
    console.log(`[${new Date().toISOString()}] Starting GitOps validation loop...`);

    // 1. Get the list of stacks, filtering by tag if GITOPS_WATCH_TAG is set
    console.log("Fetching stacks from Komodo...");
    const query: any = {};
    if (watchTag) {
        console.log(`Filtering stacks by tag: "${watchTag}"`);
        query.tags = [watchTag];
    }

    const stacks = await komodo.read("ListFullStacks", { query });
    console.log(`Found ${stacks.length} stack(s) to watch.`);

    // 2. Compute the initial hashes of every run directory
    const initialHashesMap = new Map<string, Map<string, string> | null>();

    for (const stack of stacks) {
        const runDir = stack.config?.run_directory;
        if (!runDir) {
            initialHashesMap.set(stack.name, null);
            continue;
        }

        const absoluteRunDir = path.join(mountPath, runDir);
        const hashes = await getDirectoryHashes(absoluteRunDir);
        if (hashes) {
            initialHashesMap.set(stack.name, hashes);
        } else {
            initialHashesMap.set(stack.name, null);
        }
    }

    // 3. Run Git Pull on the GitOps repository in Komodo
    console.log(`Pulling repo "${repoName}" via Komodo...`);
    const pullUpdate: any = await komodo.execute_and_poll("PullRepo", { repo: repoName });
    if (!pullUpdate.success) {
        printUpdateLogs(pullUpdate);
        throw new Error(`PullRepo on "${repoName}" failed.`);
    }

    // 4. Run Sync on the ResourceSync in Komodo
    console.log(`Running Sync "${syncName}" via Komodo...`);
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

        const absoluteRunDir = path.join(mountPath, runDir);
        const before = initialHashesMap.get(stack.name) || null;
        const after = await getDirectoryHashes(absoluteRunDir);

        // Detect differences
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
            console.log(`[CHANGE DETECTED] Stack "${stack.name}" run directory has changed:`);
            if (added.length > 0) console.log(`  Added: ${added.join(", ")}`);
            if (modified.length > 0) console.log(`  Modified: ${modified.join(", ")}`);
            if (deleted.length > 0) console.log(`  Deleted: ${deleted.join(", ")}`);

            console.log(`Triggering deploy on stack "${stack.name}"...`);
            const deployUpdate: any = await komodo.execute_and_poll("DeployStack", { stack: stack.name });
            if (deployUpdate.success) {
                console.log(`Successfully deployed stack "${stack.name}".`);
            } else {
                console.error(`Failed to deploy stack "${stack.name}"!`);
                printUpdateLogs(deployUpdate);
            }
        }
    }

    console.log(`[${new Date().toISOString()}] GitOps validation completed successfully.`);
}

// Infinite task runner loop
async function main() {
    console.log("=========================================");
    console.log("Komodo GitOps Server Daemon Started");
    console.log(`GitOps local mount path: ${mountPath}`);
    console.log(`Repository: ${repoName}`);
    console.log(`ResourceSync: ${syncName}`);
    console.log(`Komodo Server: ${komodoUrl}`);
    console.log(`Watch Tag Filter: ${watchTag ? `"${watchTag}"` : "None (watching all)"}`);
    console.log(`Interval: ${intervalMs / 1000} seconds`);
    console.log("=========================================\n");

    while (true) {
        try {
            await runGitOpsValidation();
        } catch (error: any) {
            console.error(`[${new Date().toISOString()}] Error during GitOps validation cycle:`, error.message || error);
        }
        console.log(`Sleeping for ${intervalMs / 1000} seconds before next run...\n`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

main().catch(error => {
    console.error("Fatal error in daemon initialization:", error);
    process.exit(1);
});