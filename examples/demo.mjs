import { createCatalog, createScopeRevision, estimateScope, submitReview, approveReview, exportProposal } from '../src/domain.mjs';
const catalog = createCatalog({tenantId:'studio-a',currency:'USD',version:1,
  services:[{id:'render',label:'Architectural render',unitPriceMinor:18000}]});
const scope = createScopeRevision({tenantId:'studio-a',projectId:'demo-123',revision:1,
  authorId:'alice',brief:'4 exterior renders, please.',deliverables:[
    {serviceId:'render',quantity:4,evidence:'4 exterior renders',source:'brief'}
  ]});
const estimate=estimateScope(scope,catalog);
const review=submitReview({scope,estimate,actor:{id:'alice',tenantId:'studio-a'}});
const approval=approveReview({scope,estimate,review,actor:{id:'bob',tenantId:'studio-a',roles:['reviewer']}});
console.log(exportProposal({scope,estimate,review:approval}).markdown);
