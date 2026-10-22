import type { Deliverable, ProposalMetadata, Scope } from './ports.ts';
import { ApiError } from './core.ts';

export const emptyProposal = ():ProposalMetadata => ({overview:'',assumptions:[],exclusions:[],commercialTerms:[]});
export function normalizeProposal(input?: ProposalMetadata):ProposalMetadata {
  return { overview: input?.overview ?? '', assumptions:[...(input?.assumptions ?? [])],
    exclusions:[...(input?.exclusions ?? [])], commercialTerms:[...(input?.commercialTerms ?? [])] };
}
export function normalizeScope(scope:Scope):Scope {
  return { ...scope, proposal:normalizeProposal(scope.proposal),
    deliverables:scope.deliverables.map(d=>({...d,clientDescription:d.clientDescription ?? ''})) };
}
export function validateProposal(proposal:ProposalMetadata|undefined,deliverables:readonly Deliverable[]):void {
  if(proposal) {
    if(typeof proposal.overview!=='string'||proposal.overview.length>4000)
      throw new ApiError('INVALID_INPUT',422,'Invalid proposal overview');
    for(const values of [proposal.assumptions,proposal.exclusions,proposal.commercialTerms]) {
      if(!Array.isArray(values)||values.length>50||values.some(s=>typeof s!=='string'||s.trim().length<1||s.trim().length>2000))
        throw new ApiError('INVALID_INPUT',422,'Invalid proposal list');
    }
  }
  for(const d of deliverables) if(d.clientDescription!==undefined &&
    (typeof d.clientDescription!=='string'||d.clientDescription.length>2000))
    throw new ApiError('INVALID_INPUT',422,'Invalid client description');
  const metadata={proposal:normalizeProposal(proposal),descriptions:deliverables.map(d=>d.clientDescription??'')};
  if(Buffer.byteLength(JSON.stringify(metadata),'utf8')>65536)
    throw new ApiError('INVALID_INPUT',422,'Proposal metadata is too large');
}
// Markdown source is user-authored plain text, not interpreted HTML/Markdown syntax.
const safe = (value:string):string => value.replace(/[\x00-\x1F\x7F]/g,' ').replace(/[\\`*_{}\[\]()#+.!|<>~-]/g,'\\$&');
export function renderProposalMarkdown(scope:Scope):string {
  const normalized=normalizeScope(scope), metadata=normalized.proposal!;
  const sections:string[]=[];
  if(metadata.overview) sections.push('## Overview\n\n'+safe(metadata.overview));
  for(const [name,lines] of [['Assumptions',metadata.assumptions],['Exclusions',metadata.exclusions],['Commercial terms',metadata.commercialTerms]] as const) {
    if(lines.length) sections.push('## '+name+'\n\n'+lines.map(s=>'- '+safe(s)).join('\n'));
  }
  const descriptions=normalized.deliverables.filter(d=>d.clientDescription);
  if(descriptions.length) sections.unshift('## Deliverable descriptions\n\n'+descriptions.map(d=>'- '+safe(d.serviceId)+': '+safe(d.clientDescription!)).join('\n'));
  return sections.length?'\n'+sections.join('\n\n')+'\n':'';
}
