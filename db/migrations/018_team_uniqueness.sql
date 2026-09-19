-- Migration 018: Team uniqueness constraints (P0-4)
-- Prevents duplicate team_members and team_projects rows.
ALTER TABLE team_members
  ADD UNIQUE INDEX uq_team_members_team_user (team_id, user_id);

ALTER TABLE team_projects
  ADD UNIQUE INDEX uq_team_projects_team_project (team_id, project_id);
