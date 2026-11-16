class ExpensePolicy < ApplicationPolicy
  def index?
    true
  end

  def show?
    record.team_id == user.team_id
  end

  def create?
    true
  end

  def update?
    record.user_id == user.id && record.pending?
  end

  def destroy?
    record.user_id == user.id && record.pending?
  end

  class Scope < Scope
    def resolve
      scope.where(team_id: user.team_id)
    end
  end
end
