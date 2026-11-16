class ReportPolicy < ApplicationPolicy
  def index?
    user.auditor? || user.admin?
  end

  def show?
    (user.auditor? || user.admin?) && record.organization_id == user.organization_id
  end

  def create?
    user.auditor? || user.admin?
  end

  class Scope < Scope
    def resolve
      scope.where(organization_id: user.organization_id)
    end
  end
end
