class ApprovalPolicy < ApplicationPolicy
  def index?
    true
  end

  def show?
    record.expense.team_id == user.team_id
  end

  def create?
    user.manager? || user.admin?
  end

  def update?
    (user.manager? || user.admin?) && record.expense.team_id == user.team_id
  end

  class Scope < Scope
    def resolve
      scope.joins(:expense).where(expenses: { team_id: user.team_id })
    end
  end
end
