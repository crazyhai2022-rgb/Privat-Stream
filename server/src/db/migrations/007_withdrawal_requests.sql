-- viralX: creators can request a withdrawal of their payable balance. A request is a payout with source 'request'.
alter table payouts add column source text not null default 'batch' check (source in ('batch', 'request'));
create index payouts_requests_idx on payouts (created_at desc) where source = 'request';
