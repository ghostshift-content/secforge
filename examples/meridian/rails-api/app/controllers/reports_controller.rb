class ReportsController < ActionController::API
  include Authenticatable

  def index
    reports = policy_scope(Report)
    render json: reports
  end

  def show
    report = Report.find(params[:id])
    authorize report
    render json: report
  end

  def create
    report = current_user.organization.reports.new(report_params.merge(generated_by: current_user))
    authorize report

    if report.save
      render json: report, status: :created
    else
      render json: { errors: report.errors.full_messages }, status: :unprocessable_entity
    end
  end

  private

  def report_params
    params.require(:report).permit(:report_type, :period_start, :period_end)
  end
end
