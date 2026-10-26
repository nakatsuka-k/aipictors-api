// URL（Civitai）からのモデル取り込みを行う Cloudflare Workflow。流れは lib/user-model-imports.ts の runUserModelImport
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { getDb, getNow } from "../lib/db"
import { runUserModelImport, type ImportStepRunner, type UserModelImportParams } from "../lib/user-model-imports"

export class UserModelImportWorkflow extends WorkflowEntrypoint<Env, UserModelImportParams> {
  async run(event: Readonly<WorkflowEvent<UserModelImportParams>>, step: WorkflowStep) {
    const runner: ImportStepRunner = {
      // step.do の型は戻り値に Rpc.Serializable 制約があるのでここで外す
      do: (name, config, callback) => step.do(name, config as any, callback as any) as any,
    }
    return runUserModelImport(
      event.payload,
      runner,
      async () => ({
        db: await getDb(this.env),
        bucket: this.env.USER_MODELS,
        now: getNow(),
        fetch: (input, init) => fetch(input, init),
        civitaiToken: this.env.CIVITAI_API_TOKEN ?? null,
      }),
      (e) => new NonRetryableError(e.message, e.code),
    )
  }
}
