class TeamsController < ApplicationController
  before_action :set_team, only: [:show, :update]
  before_action :ensure_admin!, only: [:create, :update]

  def index
    render json: current_user.organization.teams
  end

  def show
    render json: @team
  end

  def create
    team = current_user.organization.teams.new(team_params)

    if team.save
      render json: team, status: :created
    else
      render json: { errors: team.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def update
    if @team.update(team_params)
      render json: @team
    else
      render json: { errors: @team.errors.full_messages }, status: :unprocessable_entity
    end
  end

  private

  def set_team
    @team = current_user.organization.teams.find(params[:id])
  end

  def ensure_admin!
    return if current_user.admin?

    render json: { error: "You are not authorized to perform this action" }, status: :forbidden
  end

  def team_params
    params.require(:team).permit(:name)
  end
end
