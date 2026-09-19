content = open('api/services/batchService.ts').read()
content = content.replace('import { swarmBatches, swarmRuns, projects } from "@db/schema";',
                          'import { swarmBatches, swarmRuns } from "@db/schema";')
open('api/services/batchService.ts', 'w').write(content)
print('Fixed unused import')
