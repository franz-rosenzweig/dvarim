package xyz.tiresia.dvarim;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;

/**
 * Sends the ticks Outbox kept, once the phone has a network again. A network
 * is not the server: if it still cannot be reached, the job asks to be run
 * again later, and JobScheduler's backoff decides when.
 */
public class OutboxJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        final Context app = getApplicationContext();
        new Thread(() -> {
            if (Outbox.drain(app) > 0) TodayWidget.refresh(app);
            jobFinished(params, !Outbox.waiting(app).isEmpty());
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;                       // cut short: try again
    }
}
